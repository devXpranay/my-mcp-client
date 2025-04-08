// import { Anthropic } from "@anthropic-ai/sdk";
// import {
//     MessageParam,
//     Tool,
// } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
// import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// import readline from "readline/promises";
// import dotenv from "dotenv";

// dotenv.config();

// const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// if (!ANTHROPIC_API_KEY) {
//     throw new Error("ANTHROPIC_API_KEY is not set");
// }

// class MCPClient {
//     private mcp: Client;
//     private anthropic: Anthropic;
//     private transport: StdioClientTransport | null = null;
//     private tools: Tool[] = [];

//     constructor() {
//         this.anthropic = new Anthropic({
//             apiKey: ANTHROPIC_API_KEY,
//         });
//         this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
//     }
//     // methods will go here

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

//             this.transport = new StdioClientTransport({
//                 command,
//                 args: [serverScriptPath],
//             });
//             this.mcp.connect(this.transport);

//             const toolsResult = await this.mcp.listTools();
//             this.tools = toolsResult.tools.map((tool) => {
//                 return {
//                     name: tool.name,
//                     description: tool.description,
//                     input_schema: tool.inputSchema,
//                 };
//             });
//             console.log(
//                 "Connected to server with tools:",
//                 this.tools.map(({ name }) => name)
//             );
//         } catch (e) {
//             console.log("Failed to connect to MCP server: ", e);
//             throw e;
//         }
//     }

//     async processQuery(query: string) {
//         const messages: MessageParam[] = [
//             {
//                 role: "user",
//                 content: query,
//             },
//         ];

//         const response = await this.anthropic.messages.create({
//             model: "claude-3-5-sonnet-20241022",
//             max_tokens: 1000,
//             messages,
//             tools: this.tools,
//         });

//         const finalText = [];
//         const toolResults = [];

//         for (const content of response.content) {
//             if (content.type === "text") {
//                 finalText.push(content.text);
//             } else if (content.type === "tool_use") {
//                 const toolName = content.name;
//                 const toolArgs = content.input as { [x: string]: unknown } | undefined;

//                 const result = await this.mcp.callTool({
//                     name: toolName,
//                     arguments: toolArgs,
//                 });
//                 toolResults.push(result);
//                 finalText.push(
//                     `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
//                 );

//                 messages.push({
//                     role: "user",
//                     content: result.content as string,
//                 });

//                 const response = await this.anthropic.messages.create({
//                     model: "claude-3-5-sonnet-20241022",
//                     max_tokens: 1000,
//                     messages,
//                 });

//                 finalText.push(
//                     response.content[0].type === "text" ? response.content[0].text : ""
//                 );
//             }
//         }

//         return finalText.join("\n");
//     }

//     async chatLoop() {
//         const rl = readline.createInterface({
//             input: process.stdin,
//             output: process.stdout,
//         });

//         try {
//             console.log("\nMCP Client Started!");
//             console.log("Type your queries or 'quit' to exit.");

//             while (true) {
//                 const message = await rl.question("\nQuery: ");
//                 if (message.toLowerCase() === "quit") {
//                     break;
//                 }
//                 const response = await this.processQuery(message);
//                 console.log("\n" + response);
//             }
//         } finally {
//             rl.close();
//         }
//     }

//     async cleanup() {
//         await this.mcp.close();
//     }
// }

// async function main() {
//     if (process.argv.length < 3) {
//         console.log("Usage: node index.ts <path_to_server_script>");
//         return;
//     }
//     const mcpClient = new MCPClient();
//     try {
//         await mcpClient.connectToServer(process.argv[2]);
//         await mcpClient.chatLoop();
//     } finally {
//         await mcpClient.cleanup();
//         process.exit(0);
//     }
// }

// main();


import { Anthropic } from "@anthropic-ai/sdk";
import {
    MessageParam,
    Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";

dotenv.config();

type MCPServer = {
    transport: StdioClientTransport;
    client: Client;
    tools: Tool[];
};

class MCPClient {
    private anthropic: Anthropic;
    private servers: MCPServer[] = [];

    constructor() {
        const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        if (!ANTHROPIC_API_KEY) {
            throw new Error("ANTHROPIC_API_KEY is not set");
        }

        this.anthropic = new Anthropic({
            apiKey: ANTHROPIC_API_KEY,
        });
    }

    async connectToServer(serverScriptPath: string) {
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

        const transport = new StdioClientTransport({
            command,
            args: [serverScriptPath],
        });

        const client = new Client({
            name: `mcp-client-${this.servers.length}`,
            version: "1.0.0",
        });

        client.connect(transport);

        const toolsResult = await client.listTools();
        const tools = toolsResult.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
        }));

        this.servers.push({ transport, client, tools });

        console.log(
            `Connected to server ${serverScriptPath} with tools:`,
            tools.map(({ name }) => name)
        );
    }

    get allTools(): Tool[] {
        return this.servers.flatMap((server) => server.tools);
    }

    async callTool(toolName: string, toolArgs: object) {
        for (const server of this.servers) {
            const match = server.tools.find((t) => t.name === toolName);
            if (match) {
                return await server.client.callTool({
                    name: toolName,
                    arguments: toolArgs as { [x: string]: unknown },
                });
            }
        }
        throw new Error(`Tool ${toolName} not found in any connected server`);
    }

    async processQuery(query: string) {
        const messages: MessageParam[] = [
            {
                role: "user",
                content: query,
            },
        ];

        const response = await this.anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1000,
            messages,
            tools: this.allTools,
        });

        const finalText = [];

        for (const content of response.content) {
            if (content.type === "text") {
                finalText.push(content.text);
            } else if (content.type === "tool_use") {
                const toolName = content.name;
                const toolArgs = content.input as { [x: string]: unknown };

                const result = await this.callTool(toolName, toolArgs);

                finalText.push(
                    `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
                );

                messages.push({
                    role: "user",
                    content: result.content as string,
                });

                const nextResponse = await this.anthropic.messages.create({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 1000,
                    messages,
                });

                finalText.push(
                    nextResponse.content[0].type === "text"
                        ? nextResponse.content[0].text
                        : ""
                );
            }
        }

        return finalText.join("\n");
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
        for (const server of this.servers) {
            await server.client.close();
        }
    }
}

async function main() {
    const serverPaths = process.argv.slice(2);
    if (serverPaths.length === 0) {
        console.log("Usage: node index.ts <path_to_server_script1> <path_to_server_script2> ...");
        return;
    }

    const mcpClient = new MCPClient();
    try {
        for (const path of serverPaths) {
            await mcpClient.connectToServer(path);
        }

        await mcpClient.chatLoop();
    } finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}

main();
