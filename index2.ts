// import { Anthropic } from "@anthropic-ai/sdk";
// import {
//     MessageParam,
//     Tool,
//     MessageCreateParams,
// } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
// import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// import readline from "readline/promises";
// import dotenv from "dotenv";
// import { BASE_PROMPT } from "./constants.js";
// import chalk from "chalk";

// dotenv.config();

// const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// if (!ANTHROPIC_API_KEY) {
//     throw new Error("ANTHROPIC_API_KEY is not set");
// }

// class MCPClient {
//     private anthropic: Anthropic;
//     private connections: Array<{
//         mcp: Client;
//         transport: StdioClientTransport;
//         tools: Tool[];
//     }> = [];

//     constructor() {
//         this.anthropic = new Anthropic({
//             apiKey: ANTHROPIC_API_KEY,
//         });
//     }

//     async connectToServer(serverScriptPath: string) {
//         try {
//             const isJs = serverScriptPath.endsWith(".js");
//             const isPy = serverScriptPath.endsWith(".py");
//             if (!isJs && !isPy) {
//                 throw new Error("Server script must be a .js or .py file");
//             }
//             const command = isPy
//                 ? process.platform === "win32"
//                     ? "python"
//                     : "python3"
//                 : process.execPath;

//             const mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
//             const transport = new StdioClientTransport({
//                 command,
//                 args: [serverScriptPath],
//             });

//             mcp.connect(transport);

//             const toolsResult = await mcp.listTools();
//             const tools = toolsResult.tools.map((tool) => {
//                 return {
//                     name: tool.name,
//                     description: tool.description,
//                     input_schema: tool.inputSchema,
//                 };
//             });

//             this.connections.push({
//                 mcp,
//                 transport,
//                 tools,
//             });

//             console.log(
//                 chalk.green(`✓ Connected to server ${chalk.bold(serverScriptPath)} with tools:`),
//                 tools.map(({ name }) => chalk.cyan(name))
//             );

//             return tools;
//         } catch (e) {
//             console.log(chalk.red(`✗ Failed to connect to MCP server ${serverScriptPath}: `), e);
//             throw e;
//         }
//     }

//     async connectToMultipleServers(serverScriptPaths: string[]) {
//         const allTools: Tool[] = [];

//         for (const serverPath of serverScriptPaths) {
//             try {
//                 const tools = await this.connectToServer(serverPath);
//                 allTools.push(...tools);
//             } catch (e) {
//                 console.error(chalk.red(`✗ Failed to connect to server ${serverPath}: `), e);
//             }
//         }

//         console.log(
//             chalk.green("✓ All connections established. Available tools:"),
//             allTools.map(({ name }) => chalk.cyan(name))
//         );
//         return allTools;
//     }

//     getAllTools(): Tool[] {
//         return this.connections.flatMap(conn => conn.tools);
//     }

//     async findConnectionForTool(toolName: string) {
//         for (const connection of this.connections) {
//             const tool = connection.tools.find(t => t.name === toolName);
//             if (tool) {
//                 return { connection, tool };
//             }
//         }
//         throw new Error(`No connection found for tool: ${toolName}`);
//     }

//     async processQuery(query: string, previousMessages: MessageParam[] = []) {
//         try {
//             const startTime = Date.now();

//             // Use provided context from previous messages or start fresh
//             const messages: MessageParam[] = [
//                 ...previousMessages,
//                 {
//                     role: "user",
//                     content: query,
//                 },
//             ];

//             const allTools = this.getAllTools();
//             let hasMoreToolCalls = true;
//             let finalText: string[] = [];
//             let iteration = 0;
//             const MAX_ITERATIONS = 5;

//             while (hasMoreToolCalls && iteration < MAX_ITERATIONS) {
//                 iteration++;

//                 try {
//                     const messageParams: MessageCreateParams = {
//                         system: BASE_PROMPT,
//                         model: iteration === 1
//                             ? "claude-3-haiku-20240307"
//                             : "claude-3-5-sonnet-20241022",
//                         max_tokens: 1000,
//                         messages,
//                         tools: allTools, // Always include tools in every request
//                     };

//                     console.log(chalk.yellow(`⟳ Sending request to Claude (iteration ${iteration})...`));
//                     const response = await this.anthropic.messages.create(messageParams);
//                     console.log(chalk.green(`✓ Received response from Claude (iteration ${iteration})`));

//                     hasMoreToolCalls = false;

//                     // Store all tool calls first to handle properly
//                     const toolCalls = response.content.filter(c => c.type === "tool_use");
//                     const textContents = response.content.filter(c => c.type === "text");

//                     // Add all text contents
//                     for (const content of textContents) {
//                         finalText.push(content.text);
//                     }

//                     // Add assistant's complete response to the conversation history
//                     if (response.content.length > 0) {
//                         messages.push({
//                             role: "assistant",
//                             content: response.content,
//                         });
//                     }

//                     // No tool calls, we're done with this iteration
//                     if (toolCalls.length === 0) {
//                         continue;
//                     }

//                     hasMoreToolCalls = true; // We have tool calls to process

//                     // Process all tool calls
//                     for (const content of toolCalls) {
//                         const toolName = content.name;
//                         const toolArgs = content.input as { [x: string]: unknown } | undefined;
//                         const toolUseId = content.id;

//                         try {
//                             console.log(chalk.yellow(`🔍 Finding connection for tool: ${chalk.bold(toolName)}`));
//                             const { connection } = await this.findConnectionForTool(toolName);

//                             console.log(
//                                 chalk.magenta(`⚙️ Calling tool ${chalk.bold(toolName)} with args ${JSON.stringify(toolArgs)}`)
//                             );
//                             finalText.push(
//                                 `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
//                             );

//                             console.log(chalk.yellow(`⟳ Executing tool call ${chalk.bold(toolName)}...`));
//                             const result = await connection.mcp.callTool({
//                                 name: toolName,
//                                 arguments: toolArgs,
//                             });
//                             console.log(chalk.green(`✓ Tool call ${chalk.bold(toolName)} completed successfully`));

//                             // Add the tool result to the conversation history
//                             messages.push({
//                                 role: "user",
//                                 content: [
//                                     {
//                                         type: "tool_result",
//                                         tool_use_id: toolUseId,
//                                         content: result.content as string,
//                                     },
//                                 ],
//                             });

//                             console.log(chalk.cyan(`ℹ️ Added tool result to messages`));
//                         } catch (e: any) {
//                             console.error(chalk.red(`✗ Error calling tool ${chalk.bold(toolName)}:`), e);
//                             finalText.push(`Error calling tool ${toolName}: ${e.message}`);

//                             // Add error message to conversation history
//                             messages.push({
//                                 role: "user",
//                                 content: [
//                                     {
//                                         type: "tool_result",
//                                         tool_use_id: toolUseId,
//                                         content: `Error: ${e.message}`,
//                                     },
//                                 ],
//                             });
//                         }
//                     }
//                 } catch (e: any) {
//                     console.error(chalk.red(`✗ Error in iteration ${iteration}:`), e);
//                     finalText.push(`Error in processing: ${e.message}`);
//                     break;
//                 }
//             }

//             if (iteration >= MAX_ITERATIONS) {
//                 finalText.push("\n" + chalk.yellow("[Reached maximum number of tool call iterations]"));
//             }

//             const endTime = Date.now();
//             const totalTime = (endTime - startTime) / 1000;
//             finalText.push(chalk.blue(`\n[Response time: ${totalTime.toFixed(2)} seconds]`));

//             return finalText.join("\n");
//         } catch (e: any) {
//             console.error(chalk.red("✗ Fatal error in processQuery:"), e);
//             return `An error occurred while processing your query: ${e.message}`;
//         }
//     }

//     async chatLoop() {
//         const rl = readline.createInterface({
//             input: process.stdin,
//             output: process.stdout,
//         });

//         // Store conversation history for context
//         const chatHistory = [];
//         const messageHistory: MessageParam[] = [];

//         try {
//             console.log(chalk.green.bold("\n🚀 MCP Client Started!"));
//             console.log(chalk.cyan("Type your queries or 'quit' to exit."));
//             console.log(chalk.cyan("Special commands:"));
//             console.log(chalk.cyan("  !clear - Clear conversation history"));
//             console.log(chalk.cyan("  !history - Show conversation history"));

//             while (true) {
//                 const message = await rl.question(chalk.yellow.bold("\nQuery: "));

//                 // Handle special commands
//                 if (message.toLowerCase() === "quit") {
//                     break;
//                 } else if (message.toLowerCase() === "!clear") {
//                     chatHistory.length = 0;
//                     messageHistory.length = 0;
//                     console.log(chalk.green("✓ Conversation history cleared"));
//                     continue;
//                 } else if (message.toLowerCase() === "!history") {
//                     if (chatHistory.length === 0) {
//                         console.log(chalk.yellow("No conversation history yet"));
//                     } else {
//                         console.log(chalk.cyan.bold("\n===== Conversation History ====="));
//                         chatHistory.forEach((entry, index) => {
//                             console.log(chalk.cyan(`\n--- Exchange ${index + 1} ---`));
//                             console.log(chalk.yellow.bold("User: ") + entry.query);
//                             console.log(chalk.green.bold("Assistant: ") + entry.response);
//                         });
//                         console.log(chalk.cyan.bold("\n=============================="));
//                     }
//                     continue;
//                 }

//                 // Show context from previous messages if available
//                 if (chatHistory.length > 0) {
//                     console.log(chalk.cyan.dim("\n----- Context from previous messages -----"));
//                     // Show last 2 exchanges or all if less than 2
//                     const contextToShow = chatHistory.slice(-2);
//                     contextToShow.forEach((entry, index) => {
//                         const exchangeNumber = chatHistory.length - contextToShow.length + index + 1;
//                         console.log(chalk.yellow.dim(`[${exchangeNumber}] User: ${entry.query.substring(0, 60)}${entry.query.length > 60 ? '...' : ''}`));
//                         console.log(chalk.green.dim(`[${exchangeNumber}] Assistant: ${entry.response.split('\n')[0].substring(0, 60)}${entry.response.split('\n')[0].length > 60 ? '...' : ''}`));
//                     });
//                     console.log(chalk.cyan.dim("-----------------------------------------\n"));
//                 }

//                 // Process the query with message context
//                 const response = await this.processQuery(message, messageHistory);
//                 console.log("\n" + response);

//                 // Add to display history
//                 chatHistory.push({
//                     query: message,
//                     response: response
//                 });

//                 // Add to message context for Claude API
//                 messageHistory.push(
//                     { role: "user", content: message },
//                     { role: "assistant", content: response }
//                 );
//             }
//         } finally {
//             rl.close();
//         }
//     }

//     async cleanup() {
//         for (const connection of this.connections) {
//             await connection.mcp.close();
//         }
//     }
// }

// async function main() {
//     if (process.argv.length < 3) {
//         console.log(chalk.red("Usage: node index.ts <path_to_server_script1> [<path_to_server_script2> ...]"));
//         return;
//     }

//     console.log(chalk.cyan.bold("🤖 Starting MCP Client with colorful interface..."));

//     const serverPaths = process.argv.slice(2);
//     const mcpClient = new MCPClient();

//     try {
//         await mcpClient.connectToMultipleServers(serverPaths);
//         await mcpClient.chatLoop();
//     } finally {
//         await mcpClient.cleanup();
//         console.log(chalk.green.bold("👋 Thanks for using MCP Client!"));
//         process.exit(0);
//     }
// }

// main();




/// THIS WAS THE FINAL WORKING FILE BEFORE SHIFTING TO SOCKET