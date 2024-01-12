const { ChatOpenAI } = require("langchain/chat_models/openai");
const { initializeAgentExecutorWithOptions } = require("langchain/agents");
const { HumanMessage, AIMessage, SystemMessage } = require("langchain/schema");
const { BufferMemory, ChatMessageHistory } = require("langchain/memory");
// const { searchAndNavigateToPostResults }  = require("./search.js");
// const { scrapePageLoop }  = require("./navigation.js");
const { DynamicTool, Tool, DynamicStructuredTool, StructuredTool }  = require("langchain/tools");
const { z } = require("zod");

const OPENAI_API_KEY = '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';
const SYSTEM_MESSAGE = `You are a helpful assistant that helps users to understand their LinkedIn updates more easily. You are provided data and use it to make the user's life easier with helpful summaries and other useful informal along with references to the original posts.`;

const chat = new ChatOpenAI({ 
  modelName: "gpt-3.5-turbo-16k", // "gpt-4",
  temperature: 0,
  streaming: true,
  openAIApiKey: OPENAI_API_KEY,
});

async function buildExecutor(historyReq) {
  let history = [];
  history = history.concat(historyReq.map(message => message.sender === "You" ? new HumanMessage(message.text) : new AIMessage(message.text)));

  const memory = new BufferMemory({
    memoryKey: "chat_history",
    returnMessages: true,
    inputKey: "input",
    outputKey: "output",
    chatHistory: new ChatMessageHistory(history),
  });

  const executor = await initializeAgentExecutorWithOptions(allTools, chat, {
    agentType: "openai-functions",
    verbose: true,
    memory: memory,
    agentArgs: {
      prefix: SYSTEM_MESSAGE, // NB: This should be `systemMessage` not `prefix`
    }
  });

  return executor;
}

// Search tool
const searchTool = new DynamicStructuredTool({
  name: "search",
  description: "Call this to search LinkedIn for posts on some topic. The input should a be a string containing the search query. There is no return value, but the search results page will be navigated to.",
  func: async ({ query }) => {
      console.log('Running search tool...');

      if (typeof query !== "string") {
        throw new Error("Input must be a string");
      }

      await searchAndNavigateToPostResults(query);
      return null;
  },
  schema: z.object({
    query: z.string().describe('The search query'),
  }),
});

// Scraping tool
const scrapeTool = new DynamicStructuredTool({
  name: "scrape",
  description: "Call this to scrape the posts on the current page. There is no input. The return value is an stringified array of scraped posts.",
  func: async ({}) => {
      console.log('Running scraping tool...');

      let posts = await scrapePageLoop(null, 1, 1000, 1500);
      return JSON.stringify(posts);
  },
  schema: z.object({}),
});

// Search and scrape tool
const searchAndScrapeTool = new DynamicStructuredTool({
  name: "searchAndScrape",
  description: "Call this to search LinkedIn for posts on some topic and scrape the results. The input should a be a string containing the search query. The return value is an stringified array of scraped posts.",
  func: async ({ query }) => {
      console.log('Running search and scrape tool...');

      if (typeof query !== "string") {
        throw new Error("Input must be a string");
      }

      await searchAndNavigateToPostResults(query);
      let posts = await scrapePageLoop(null, 2, 1000, 1500);
      
      // Remove postHTML field from all posts
      posts.forEach(post => delete post.postHTML);
      
      return JSON.stringify(posts);
  },
  schema: z.object({
    query: z.string().describe('The search query'),
  }),
});

const allTools = [searchAndScrapeTool];

module.exports = {
  buildExecutor,
  allTools,
};