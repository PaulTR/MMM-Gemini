const NodeHelper = require("node_helper");
const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = NodeHelper.create({
  socketNotificationReceived: async function (notification, payload) {
    if (notification === "GENERATE_GEMINI_TEXT") {
      const apiKey = payload.apiKey;
      const prompt = "write a story about a magic mirror";
      const modelName = payload.model || "gemini-pro"; // Default to gemini-pro if no model is specified

      if (!apiKey) {
        console.error("Gemini API key is missing.");
        this.sendSocketNotification("GEMINI_TEXT_ERROR", { error: "API key missing" });
        return;
      }

      if (!prompt) {
        console.error("Gemini prompt is missing.");
        this.sendSocketNotification("GEMINI_TEXT_ERROR", { error: "Prompt missing" });
        return;
      }

      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        this.sendSocketNotification("GEMINI_TEXT_RESULT", { text: text });
      } catch (error) {
        console.error("Error generating text with Gemini:", error);
        this.sendSocketNotification("GEMINI_TEXT_ERROR", { error: error.message });
      }
    }
  },
});