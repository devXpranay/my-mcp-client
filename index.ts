import { Anthropic } from "@anthropic-ai/sdk";
import {
    MessageParam,
    Tool,
    MessageCreateParams,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import { BASE_PROMPT } from "./constants.js";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
}

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
                `Connected to server ${serverScriptPath} with tools:`,
                tools.map(({ name }) => name)
            );

            return tools;
        } catch (e) {
            console.log(`Failed to connect to MCP server ${serverScriptPath}: `, e);
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
                console.error(`Failed to connect to server ${serverPath}: `, e);
            }
        }

        console.log("All connections established. Available tools:", allTools.map(({ name }) => name));
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

    async processQuery(query: string) {
        try {
            const messages: MessageParam[] = [
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

            while (hasMoreToolCalls && iteration < MAX_ITERATIONS) {
                iteration++;

                try {
                    const messageParams: MessageCreateParams = {
                        system: BASE_PROMPT,
                        model: iteration === 1
                            ? "claude-3-haiku-20240307"
                            : "claude-3-5-sonnet-20241022",
                        max_tokens: 1000,
                        messages,
                        tools: allTools, // Always include tools in every request
                    };

                    console.log(`Sending request to Claude (iteration ${iteration})...`);
                    const response = await this.anthropic.messages.create(messageParams);
                    console.log("response from claude:::", response)
                    console.log("message input", JSON.stringify(response.content, null, 2))
                    console.log(`Received response from Claude (iteration ${iteration})`);

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
                            console.log(`Finding connection for tool: ${toolName}`);
                            const { connection } = await this.findConnectionForTool(toolName);

                            console.log(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);
                            finalText.push(
                                `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
                            );

                            console.log(`Executing tool call ${toolName}...`);
                            const result = await connection.mcp.callTool({
                                name: toolName,
                                arguments: toolArgs,
                            });
                            console.log(`Tool call ${toolName} completed successfully`);

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

                            console.log(`Added tool result to messages:`, result.content);
                        } catch (e: any) {
                            console.error(`Error calling tool ${toolName}:`, e);
                            finalText.push(`Error calling tool ${toolName}: ${e.message}`);

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
                    console.error(`Error in iteration ${iteration}:`, e);
                    finalText.push(`Error in processing: ${e.message}`);
                    break;
                }
            }

            if (iteration >= MAX_ITERATIONS) {
                finalText.push("\n[Reached maximum number of tool call iterations]");
            }

            return finalText.join("\n");
        } catch (e: any) {
            console.error("Fatal error in processQuery:", e);
            return `An error occurred while processing your query: ${e.message}`;
        }
    }

    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        try {
            console.log("\nMCP Client Started!");
            console.log("Type your queries or 'quit' to exit.");

            while (true) {
                const message = await rl.question("\nQuery: ");
                if (message.toLowerCase() === "quit") {
                    break;
                }
                const response = await this.processQuery(message);
                console.log("\n" + response);
            }
        } finally {
            rl.close();
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
        console.log("Usage: node index.ts <path_to_server_script1> [<path_to_server_script2> ...]");
        return;
    }

    const serverPaths = process.argv.slice(2);
    const mcpClient = new MCPClient();

    try {
        await mcpClient.connectToMultipleServers(serverPaths);
        await mcpClient.chatLoop();
    } finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}

main();