import { Anthropic } from "@anthropic-ai/sdk";
import {
    MessageParam,
    Tool,
    MessageCreateParams,
    TextBlockParam,
    ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import { BASE_PROMPT, colors } from "./constants.js";

dotenv.config();

function colorize(text: string, color: keyof typeof colors): string {
    return `${colors[color]}${text}${colors.reset}`;
}

function formatElapsedTime(startTime: number): string {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs < 1000) {
        return `${elapsedMs}ms`;
    } else {
        const seconds = Math.floor(elapsedMs / 1000);
        const ms = elapsedMs % 1000;
        return `${seconds}.${ms.toString().padStart(3, '0')}s`;
    }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
    console.error(colorize("ERROR: ANTHROPIC_API_KEY is not set", "red"));
    throw new Error("ANTHROPIC_API_KEY is not set");
}

class MCPClient {
    private anthropic: Anthropic;
    private connections: Array<{
        mcp: Client;
        transport: StdioClientTransport;
        tools: Tool[];
    }> = [];

    private userContext: {
        walletAddress: string | null;
    } = {
            walletAddress: null
        };

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
                colorize("✓ Connected to server ", "green") +
                colorize(serverScriptPath, "cyan") +
                colorize(" with tools: ", "green") +
                colorize(tools.map(({ name }) => name).join(", "), "cyan")
            );

            return tools;
        } catch (e) {
            console.log(
                colorize("✗ Failed to connect to MCP server ", "red") +
                colorize(serverScriptPath, "cyan") +
                colorize(": ", "red") +
                colorize(String(e), "red")
            );
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
                console.error(
                    colorize("✗ Failed to connect to server ", "red") +
                    colorize(serverPath, "cyan") +
                    colorize(": ", "red") +
                    colorize(String(e), "red")
                );
            }
        }

        console.log(
            colorize("✓ All connections established. Available tools: ", "green") +
            colorize(allTools.map(({ name }) => name).join(", "), "cyan")
        );
        return allTools;
    }

    private extractWalletAddress(message: string): string | null {

        const solanaRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
        const solanaMatches = message.match(solanaRegex);
        if (solanaMatches && solanaMatches.length > 0) {
            console.log(colorize(`Detected Solana address: ${solanaMatches[0]}`, "cyan"));
            return solanaMatches[0];
        }

        return null;
    }

    private formatWalletAddress(address: string | null): string {
        if (!address) return "No wallet address";

        return `${address.substring(0, 4)}...${address.substring(address.length - 3)}`;
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

    private enrichToolArguments(toolName: string, toolArgs: any): any {
        const enrichedArgs = { ...toolArgs };

        if (this.userContext.walletAddress) {
            if (toolName === "check-token-balance" && !enrichedArgs.publicKey) {
                enrichedArgs.publicKey = this.userContext.walletAddress;
                console.log(colorize(`Automatically adding wallet address to ${toolName} arguments`, "green"));
            }

            if (toolName === "prepare-unsigned-transaction-for-swap" && !enrichedArgs.fromAddress) {
                enrichedArgs.fromAddress = this.userContext.walletAddress;
                console.log(colorize(`Automatically adding wallet address to ${toolName} arguments as fromAddress`, "green"));
            }
        }

        return enrichedArgs;
    }

    async processQuery(query: string) {
        try {
            const walletAddress = this.extractWalletAddress(query);
            if (walletAddress) {
                this.userContext.walletAddress = walletAddress;
                console.log(colorize(`Detected wallet address: ${walletAddress}`, "cyan"));
            }

            const overallStartTime = Date.now();
            const messages: MessageParam[] = [
                {
                    role: "user",
                    content: query,
                },
            ];

            let systemPrompt = BASE_PROMPT;
            if (this.userContext.walletAddress) {
                systemPrompt += `\n\nThe user's wallet address is: ${this.userContext.walletAddress}. When using tools like check-token-balance, you MUST include this wallet address in the appropriate parameter (publicKey for check-token-balance, fromAddress for prepare-unsigned-transaction-for-swap). Do not submit empty arguments for these tools.`;
            }

            const allTools = this.getAllTools();
            let hasMoreToolCalls = true;
            let finalText: string[] = [];
            let iteration = 0;
            const MAX_ITERATIONS = 5;

            while (hasMoreToolCalls && iteration < MAX_ITERATIONS) {
                iteration++;
                const iterationStartTime = Date.now();

                try {
                    const messageParams: MessageCreateParams = {
                        system: systemPrompt,
                        model: iteration === 1 ? "claude-3-haiku-20240307" : "claude-3-haiku-20240307",
                        max_tokens: 1000,
                        messages,
                        tools: allTools,
                    };

                    console.log(colorize(`\n[Iteration ${iteration}] Sending request to Claude...`, "blue"));
                    const response = await this.anthropic.messages.create(messageParams);
                    const iterationElapsed = formatElapsedTime(iterationStartTime);
                    console.log(colorize(`Received response from Claude (${iterationElapsed})`, "blue"));

                    hasMoreToolCalls = false;

                    const toolCalls = response.content.filter(c => c.type === "tool_use");
                    const textContents = response.content.filter(c => c.type === "text");

                    for (const content of textContents) {
                        finalText.push(colorize(content.text, "blue"));
                    }

                    if (response.content.length > 0) {
                        messages.push({
                            role: "assistant",
                            content: response.content,
                        });
                    }

                    if (toolCalls.length === 0) {
                        continue;
                    }

                    hasMoreToolCalls = true;

                    for (const content of toolCalls) {
                        const toolName = content.name;
                        let toolArgs = content.input as { [x: string]: unknown } | undefined;
                        const toolUseId = content.id;
                        const toolCallStartTime = Date.now();

                        try {
                            console.log(colorize(`Finding connection for tool: ${toolName}`, "blue"));
                            const { connection } = await this.findConnectionForTool(toolName);

                            // Enrich tool arguments with context information
                            toolArgs = this.enrichToolArguments(toolName, toolArgs || {});

                            console.log(colorize(`[Calling tool ${toolName}]`, "blue"));
                            console.log(colorize(`Arguments: ${JSON.stringify(toolArgs, null, 2)}`, "blue"));
                            finalText.push(
                                colorize(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`, "blue")
                            );

                            console.log(colorize(`Executing tool call ${toolName}...`, "blue"));
                            const result = await connection.mcp.callTool({
                                name: toolName,
                                arguments: toolArgs,
                            });
                            const toolCallElapsed = formatElapsedTime(toolCallStartTime);
                            console.log(colorize(`Tool call completed (${toolCallElapsed})`, "green"));
                            console.log(colorize(`Result: ${typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2)}`, "green"));

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

                            finalText.push(colorize(`Tool Result: ${result.content}`, "green"));
                        } catch (e: any) {
                            console.error(colorize(`Error calling tool ${toolName}: ${e.message}`, "red"));
                            finalText.push(colorize(`Error calling tool ${toolName}: ${e.message}`, "red"));

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
                    console.error(colorize(`Error in iteration ${iteration}: ${e.message}`, "red"));
                    finalText.push(colorize(`Error in processing: ${e.message}`, "red"));
                    break;
                }
            }

            if (iteration >= MAX_ITERATIONS) {
                finalText.push(colorize("\n[Reached maximum number of tool call iterations]", "yellow"));
            }

            const totalElapsed = formatElapsedTime(overallStartTime);
            finalText.push(colorize(`\nTotal time: ${totalElapsed}`, "yellow"));

            return finalText.join("\n");
        } catch (e: any) {
            console.error(colorize(`Fatal error in processQuery: ${e.message}`, "red"));
            return colorize(`An error occurred while processing your query: ${e.message}`, "red");
        }
    }

    async processQueryWithStreaming(query: string) {
        try {
            const walletAddress = this.extractWalletAddress(query);
            if (walletAddress) {
                this.userContext.walletAddress = walletAddress;
                console.log(colorize(`Detected wallet address: ${walletAddress}`, "cyan"));
            }

            const overallStartTime = Date.now();
            const messages: MessageParam[] = [
                {
                    role: "user",
                    content: query,
                },
            ];

            let systemPrompt = BASE_PROMPT;
            if (this.userContext.walletAddress) {
                systemPrompt += `\n\nThe user's wallet address is: ${this.userContext.walletAddress}. When using tools like check-token-balance, you MUST include this wallet address in the appropriate parameter (publicKey for check-token-balance, fromAddress for prepare-unsigned-transaction-for-swap). Do not submit empty arguments for these tools.`;
            }

            const allTools = this.getAllTools();
            let iteration = 0;
            const MAX_ITERATIONS = 5;

            while (iteration < MAX_ITERATIONS) {
                iteration++;
                const iterationStartTime = Date.now();

                try {
                    console.log(colorize(`\n[Iteration ${iteration}] Sending request to Claude...`, "blue"));

                    const stream = await this.anthropic.messages.create({
                        system: systemPrompt,
                        model: iteration === 1 ? "claude-3-haiku-20240307" : "claude-3-5-sonnet-20241022",
                        max_tokens: 1000,
                        messages,
                        tools: allTools,
                        stream: true,
                    });

                    interface ContentBlock {
                        type: string;
                        id?: string;
                        text?: string;
                        name?: string;
                        input?: any;
                    }

                    const contentBlocks: Map<number, ContentBlock> = new Map();
                    let toolCalls: ContentBlock[] = [];

                    console.log(colorize("\n[Claude's response]", "blue"));

                    for await (const chunk of stream) {
                        if (chunk.type === "content_block_start") {
                            const index = chunk.index;
                            const block = chunk.content_block;

                            if (block.type === "tool_use") {
                                toolCalls.push({
                                    type: "tool_use",
                                    id: block.id,
                                    name: block.name,
                                    input: block.input
                                });

                                console.log(colorize(`\n[Tool Call: ${block.name}]`, "blue"));
                                console.log(colorize(`With arguments: ${JSON.stringify(block.input, null, 2)}`, "blue"));
                            } else if (block.type === "text") {
                                contentBlocks.set(index, { type: "text", text: "" });
                            }
                        } else if (chunk.type === "content_block_delta") {
                            const index = chunk.index;

                            if (chunk.delta.type === "text_delta") {
                                const block = contentBlocks.get(index) || { type: "text", text: "" };
                                block.text = (block.text || "") + chunk.delta.text;
                                contentBlocks.set(index, block);

                                process.stdout.write(colorize(chunk.delta.text, "blue"));
                            }
                        } else if (chunk.type === "message_stop") {
                            const iterationElapsed = formatElapsedTime(iterationStartTime);
                            console.log(colorize(`\n[Response complete in ${iterationElapsed}]`, "yellow"));
                        }
                    }

                    const contentArray: ContentBlock[] = [];

                    for (let i = 0; i < contentBlocks.size; i++) {
                        const block = contentBlocks.get(i);
                        if (block && block.type === "text") {
                            contentArray.push({
                                type: "text",
                                text: block.text
                            });
                        }
                    }

                    toolCalls.forEach(tool => {
                        contentArray.push(tool);
                    });

                    messages.push({
                        role: 'assistant',
                        content: contentArray.map(block => {
                            if (block.type === "text") {
                                return {
                                    type: "text",
                                    text: block.text || "",
                                } satisfies TextBlockParam;
                            } else if (block.type === "tool_use") {
                                return {
                                    type: "tool_use",
                                    id: block.id || "",
                                    name: block.name || "",
                                    input: block.input || {},
                                } satisfies ToolUseBlockParam;
                            } else {
                                throw new Error(`Unsupported block type: ${block.type}`);
                            }
                        }),
                    });

                    if (toolCalls.length === 0) {
                        break;
                    }

                    for (const tool of toolCalls) {
                        const toolCallStartTime = Date.now();
                        try {
                            console.log(colorize(`\n[Executing tool: ${tool.name}]`, "blue"));

                            const enrichedArgs = this.enrichToolArguments(tool.name!, tool.input || {});

                            console.log(colorize(`Arguments: ${JSON.stringify(enrichedArgs, null, 2)}`, "blue"));

                            const { connection } = await this.findConnectionForTool(tool.name!);
                            const result = await connection.mcp.callTool({
                                name: tool.name!,
                                arguments: enrichedArgs,
                            });

                            const toolCallElapsed = formatElapsedTime(toolCallStartTime);
                            console.log(colorize(`[Tool execution complete in ${toolCallElapsed}]`, "yellow"));
                            console.log(colorize(`[Tool result]:`, "green"));
                            console.log(colorize(typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2), "green"));

                            messages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "tool_result",
                                        tool_use_id: tool.id!,
                                        content: result.content as string,
                                    },
                                ],
                            });
                        } catch (e: any) {
                            console.error(colorize(`\n[Error calling tool ${tool.name}:] ${e.message}`, "red"));

                            messages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "tool_result",
                                        tool_use_id: tool.id!,
                                        content: `Error: ${e.message}`,
                                    },
                                ],
                            });
                        }
                    }

                    toolCalls = [];

                } catch (e: any) {
                    console.error(colorize(`\n[Error in iteration ${iteration}:] ${e.message}`, "red"));
                    break;
                }
            }

            if (iteration >= MAX_ITERATIONS) {
                console.log(colorize("\n[Reached maximum number of tool call iterations]", "yellow"));
            }

            const totalElapsed = formatElapsedTime(overallStartTime);
            console.log(colorize(`\nTotal time: ${totalElapsed}`, "yellow"));

            return "";
        } catch (e: any) {
            console.error(colorize(`\n[Fatal error:] ${e.message}`, "red"));
            return colorize(`An error occurred: ${e.message}`, "red");
        }
    }

    getWalletAddress(): string | null {
        return this.userContext.walletAddress;
    }

    clearWalletAddress(): void {
        this.userContext.walletAddress = null;
        console.log(colorize("Wallet address cleared from context", "cyan"));
    }

    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        try {
            console.log(colorize("\n=== MCP Client Started! ===", "magenta"));
            console.log(colorize("- 'wallet': Show current wallet address", "cyan"));
            console.log(colorize("- 'clear wallet': Clear stored wallet address", "cyan"));

            let useStreaming = true;

            while (true) {
                const walletInfo = this.userContext.walletAddress ?
                    ` (Wallet: ${this.formatWalletAddress(this.userContext.walletAddress)})` :
                    '';

                const message = await rl.question(
                    colorize(`\nQuery${walletInfo} ${useStreaming ? "(streaming)" : "(non-streaming)"}: `, "white")
                );

                if (message.toLowerCase() === "quit") {
                    break;
                } else if (message.toLowerCase() === "stream") {
                    useStreaming = !useStreaming;
                    console.log(colorize(`\nStreaming mode ${useStreaming ? "enabled" : "disabled"}`, "cyan"));
                    continue;
                } else if (message.toLowerCase() === "wallet") {
                    if (this.userContext.walletAddress) {
                        console.log(colorize(`Current wallet address: ${this.userContext.walletAddress}`, "cyan"));
                    } else {
                        console.log(colorize("No wallet address detected yet.", "yellow"));
                    }
                    continue;
                } else if (message.toLowerCase() === "clear wallet") {
                    this.clearWalletAddress();
                    continue;
                }

                if (useStreaming) {
                    await this.processQueryWithStreaming(message);
                } else {
                    const response = await this.processQuery(message);
                    console.log("\n" + response);
                }

                if (this.userContext.walletAddress && this.extractWalletAddress(message)) {
                    console.log(colorize(`Wallet address saved to context: ${this.formatWalletAddress(this.userContext.walletAddress)}`, "green"));
                }
            }
        } finally {
            rl.close();
        }
    }

    async cleanup() {
        for (const connection of this.connections) {
            await connection.mcp.close();
        }
        console.log(colorize("\n=== MCP Client Stopped ===", "magenta"));
    }
}

async function main() {
    if (process.argv.length < 3) {
        console.log(colorize("Usage: node index.ts <path_to_server_script1> [<path_to_server_script2> ...]", "yellow"));
        return;
    }

    const serverPaths = process.argv.slice(2);
    const mcpClient = new MCPClient();

    try {
        console.log(colorize("=== Starting MCP Client ===", "magenta"));
        await mcpClient.connectToMultipleServers(serverPaths);
        await mcpClient.chatLoop();
    } catch (e) {
        console.error(colorize(`Fatal error: ${e}`, "red"));
    } finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}

main();