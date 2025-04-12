import { Anthropic } from "@anthropic-ai/sdk";
import {
    MessageParam,
    Tool,
    MessageCreateParams,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from "dotenv";
import { BASE_PROMPT } from "./constants.js";
import chalk from "chalk";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
}

// Map to store user sessions
const userSessions = new Map();

class MCPClient {
    private anthropic: Anthropic;
    private connections: Array<{
        mcp: Client;
        transport: StdioClientTransport;
        tools: Tool[];
    }> = [];

    constructor() {
        this.anthropic = new Anthropic({
            apiKey: ANTHROPIC_API_KEY,
        });
    }

    async connectToServer(serverScriptPath: string) {
        try {
            const isJs = serverScriptPath.endsWith(".js");
            const isPy = serverScriptPath.endsWith(".py");
            if (!isJs && !isPy) {
                throw new Error("Server script must be a .js or .py file");
            }
            const command = isPy
                ? process.platform === "win32"
                    ? "python"
                    : "python3"
                : process.execPath;

            const mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
            const transport = new StdioClientTransport({
                command,
                args: [serverScriptPath],
            });

            mcp.connect(transport);

            const toolsResult = await mcp.listTools();
            const tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                };
            });

            this.connections.push({
                mcp,
                transport,
                tools,
            });

            console.log(
                chalk.green(`✓ Connected to server ${chalk.bold(serverScriptPath)} with tools:`),
                tools.map(({ name }) => chalk.cyan(name))
            );

            return tools;
        } catch (e) {
            console.log(chalk.red(`✗ Failed to connect to MCP server ${serverScriptPath}: `), e);
            throw e;
        }
    }

    async connectToMultipleServers(serverScriptPaths: string[]) {
        const allTools: Tool[] = [];

        for (const serverPath of serverScriptPaths) {
            try {
                const tools = await this.connectToServer(serverPath);
                allTools.push(...tools);
            } catch (e) {
                console.error(chalk.red(`✗ Failed to connect to server ${serverPath}: `), e);
            }
        }

        console.log(
            chalk.green("✓ All connections established. Available tools:"),
            allTools.map(({ name }) => chalk.cyan(name))
        );
        return allTools;
    }

    getAllTools(): Tool[] {
        return this.connections.flatMap(conn => conn.tools);
    }

    async findConnectionForTool(toolName: string) {
        for (const connection of this.connections) {
            const tool = connection.tools.find(t => t.name === toolName);
            if (tool) {
                return { connection, tool };
            }
        }
        throw new Error(`No connection found for tool: ${toolName}`);
    }

    async processQuery(query: string, socketId: string, socket: any) {
        try {
            const startTime = Date.now();

            // Get user session or create new one
            if (!userSessions.has(socketId)) {
                userSessions.set(socketId, {
                    messageHistory: [],
                    chatHistory: []
                });
            }

            const userSession = userSessions.get(socketId);
            const { messageHistory } = userSession;

            // Use provided context from previous messages or start fresh
            const messages: MessageParam[] = [
                ...messageHistory,
                {
                    role: "user",
                    content: query,
                },
            ];

            const allTools = this.getAllTools();
            let hasMoreToolCalls = true;
            let finalText: string[] = [];
            let iteration = 0;
            const MAX_ITERATIONS = 5;

            // Send acknowledgment that query processing has started
            socket.emit('processing_started', {
                message: 'Processing your query...',
                timestamp: new Date().toISOString()
            });

            while (hasMoreToolCalls && iteration < MAX_ITERATIONS) {
                iteration++;

                try {
                    const messageParams: MessageCreateParams = {
                        system: BASE_PROMPT,
                        model: "claude-3-haiku-20240307",
                        max_tokens: 1000,
                        messages,
                        tools: allTools, // Always include tools in every request
                    };

                    console.log(chalk.yellow(`⟳ Sending request to Claude (iteration ${iteration}) for user ${socketId}...`));
                    socket.emit('llm_thinking', {
                        message: `Thinking... (iteration ${iteration})`,
                        iteration: iteration,
                        timestamp: new Date().toISOString()
                    });

                    const response = await this.anthropic.messages.create(messageParams);
                    console.log(chalk.green(`✓ Received response from Claude (iteration ${iteration}) for user ${socketId}`));

                    hasMoreToolCalls = false;

                    // Store all tool calls first to handle properly
                    const toolCalls = response.content.filter(c => c.type === "tool_use");
                    const textContents = response.content.filter(c => c.type === "text");

                    // Add all text contents
                    for (const content of textContents) {
                        finalText.push(content.text);
                    }

                    // Add assistant's complete response to the conversation history
                    if (response.content.length > 0) {
                        messages.push({
                            role: "assistant",
                            content: response.content,
                        });
                    }

                    // No tool calls, we're done with this iteration
                    if (toolCalls.length === 0) {
                        continue;
                    }

                    hasMoreToolCalls = true; // We have tool calls to process

                    // Process all tool calls
                    for (const content of toolCalls) {
                        const toolName = content.name;
                        const toolArgs = content.input as { [x: string]: unknown } | undefined;
                        const toolUseId = content.id;

                        try {
                            console.log(chalk.yellow(`🔍 Finding connection for tool: ${chalk.bold(toolName)} for user ${socketId}`));
                            const { connection } = await this.findConnectionForTool(toolName);

                            console.log(
                                chalk.magenta(`⚙️ Calling tool ${chalk.bold(toolName)} with args ${JSON.stringify(toolArgs)} for user ${socketId}`)
                            );

                            socket.emit('tool_called', {
                                tool: toolName,
                                args: toolArgs,
                                timestamp: new Date().toISOString()
                            });

                            finalText.push(
                                `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
                            );

                            console.log(chalk.yellow(`⟳ Executing tool call ${chalk.bold(toolName)} for user ${socketId}...`));
                            const result = await connection.mcp.callTool({
                                name: toolName,
                                arguments: toolArgs,
                            });
                            console.log(chalk.green(`✓ Tool call ${chalk.bold(toolName)} completed successfully for user ${socketId}`));

                            // IMPORTANT: Emit the raw tool result to the client
                            socket.emit('tool_result', {
                                tool: toolName,
                                args: toolArgs,
                                result: result.content,
                                timestamp: new Date().toISOString()
                            });

                            // Add the tool result to the conversation history
                            messages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "tool_result",
                                        tool_use_id: toolUseId,
                                        content: result.content as string,
                                    },
                                ],
                            });

                            console.log(chalk.cyan(`ℹ️ Added tool result to messages for user ${socketId}`));
                        } catch (e: any) {
                            console.error(chalk.red(`✗ Error calling tool ${chalk.bold(toolName)} for user ${socketId}:`), e);
                            finalText.push(`Error calling tool ${toolName}: ${e.message}`);

                            // Emit tool error to client
                            socket.emit('tool_error', {
                                tool: toolName,
                                args: toolArgs,
                                error: e.message,
                                timestamp: new Date().toISOString()
                            });

                            // Add error message to conversation history
                            messages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "tool_result",
                                        tool_use_id: toolUseId,
                                        content: `Error: ${e.message}`,
                                    },
                                ],
                            });
                        }
                    }
                } catch (e: any) {
                    console.error(chalk.red(`✗ Error in iteration ${iteration} for user ${socketId}:`), e);
                    finalText.push(`Error in processing: ${e.message}`);

                    socket.emit('error', {
                        message: `Error in processing: ${e.message}`,
                        iteration: iteration,
                        timestamp: new Date().toISOString()
                    });

                    break;
                }
            }

            if (iteration >= MAX_ITERATIONS) {
                finalText.push("\n" + chalk.yellow("[Reached maximum number of tool call iterations]"));
                socket.emit('max_iterations_reached', {
                    message: "Reached maximum number of tool call iterations",
                    timestamp: new Date().toISOString()
                });
            }

            const endTime = Date.now();
            const totalTime = (endTime - startTime) / 1000;
            finalText.push(`\n[Response time: ${totalTime.toFixed(2)} seconds]`);

            // Update the user's message history
            userSession.messageHistory = messages;

            // Add to chat history for display
            userSession.chatHistory.push({
                query: query,
                response: finalText.join("\n")
            });

            // Emit final response to client
            socket.emit('final_response', {
                response: finalText.join("\n"),
                totalTime: totalTime.toFixed(2),
                timestamp: new Date().toISOString()
            });

            return finalText.join("\n");
        } catch (e: any) {
            console.error(chalk.red(`✗ Fatal error in processQuery for user ${socketId}:`), e);
            socket.emit('error', {
                message: `An error occurred while processing your query: ${e.message}`,
                timestamp: new Date().toISOString()
            });
            return `An error occurred while processing your query: ${e.message}`;
        }
    }

    async cleanup() {
        for (const connection of this.connections) {
            await connection.mcp.close();
        }
    }
}

async function main() {
    if (process.argv.length < 3) {
        console.log(chalk.red("Usage: node server.js <path_to_server_script1> [<path_to_server_script2> ...]"));
        return;
    }

    console.log(chalk.cyan.bold("🚀 Starting Socket.IO MCP Server..."));

    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, {
        cors: {
            origin: "*", // In production, restrict this to your client's domain
            methods: ["GET", "POST"]
        }
    });

    const serverPaths = process.argv.slice(2);
    const mcpClient = new MCPClient();

    try {
        // Connect to all MCP servers
        await mcpClient.connectToMultipleServers(serverPaths);

        // Set up Socket.IO connection handling
        io.on('connection', (socket: any) => {
            const socketId = socket.id;
            console.log(chalk.green(`✓ New client connected: ${chalk.bold(socketId)}`));

            // Send connection confirmation with session ID and tools
            socket.emit('connected', {
                sessionId: socket.id,
                message: 'Connection established with MCP Server',
                availableTools: mcpClient.getAllTools().map(tool => tool.name),
                timestamp: new Date().toISOString()
            });

            // Also keep the available_tools emission if needed elsewhere
            socket.emit('available_tools', {
                tools: mcpClient.getAllTools().map(tool => ({
                    name: tool.name,
                    description: tool.description
                })),
                timestamp: new Date().toISOString()
            });

            // Handle user queries
            socket.on('query', async (data: any) => {
                console.log(chalk.yellow(`⟳ Received query from user ${chalk.bold(socketId)}: ${data.message}`));
                await mcpClient.processQuery(data.message, socketId, socket);
            });

            // Handle client disconnection
            socket.on('disconnect', () => {
                console.log(chalk.yellow(`⟳ Client disconnected: ${chalk.bold(socketId)}`));
                // Clean up user session
                if (userSessions.has(socketId)) {
                    userSessions.delete(socketId);
                }
            });

            // Handle history retrieval
            socket.on('get_history', () => {
                if (userSessions.has(socketId)) {
                    const { chatHistory } = userSessions.get(socketId);
                    socket.emit('history', {
                        history: chatHistory,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    socket.emit('history', {
                        history: [],
                        timestamp: new Date().toISOString()
                    });
                }
            });

            // Handle history clearing
            socket.on('clear_history', () => {
                if (userSessions.has(socketId)) {
                    const userSession = userSessions.get(socketId);
                    userSession.messageHistory = [];
                    userSession.chatHistory = [];
                    socket.emit('history_cleared', {
                        message: 'Conversation history cleared',
                        timestamp: new Date().toISOString()
                    });
                }
            });
        });

        // Start the server
        const PORT = process.env.PORT || 8000;
        httpServer.listen(PORT, () => {
            console.log(chalk.green.bold(`🚀 Socket.IO MCP Server running on http://localhost:${PORT}`));
            console.log(chalk.green(`Connected to ${serverPaths.length} MCP servers with tools`));
        });

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log(chalk.yellow('Shutting down server...'));
            await mcpClient.cleanup();
            process.exit(0);
        });

    } catch (error) {
        console.error(chalk.red('Failed to start server:'), error);
        await mcpClient.cleanup();
        process.exit(1);
    }
}

// console.log("Hello", "\x1b[46m", "World", "\x1b[0m");


main();