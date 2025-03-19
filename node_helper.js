const NodeHelper = require("node_helper");
const { GoogleGenAI } = require("@google/genai");

module.exports = NodeHelper.create({

  genAi: null,
  model: null,

  initializeGenAI: function(apiKey) {
    if (!this.genAI) {
        const ai = new GoogleGenAI({ apiKey: apiKey });
      log("Created genai")
    }
  },

  async socketNotificationReceived(notification, payload) {
    if (notification === "GET_RANDOM_TEXT") {
      const amountCharacters = payload.amountCharacters || 10;
      const randomText = Array.from({ length: amountCharacters }, () =>
        String.fromCharCode(Math.floor(Math.random() * 26) + 97)
      ).join("");
      this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText });
    }
    if (notification === "GENERATE_TEXT") {
      log("Generate_text")
      
      if( !this.genAI) {
        log("genAI not defined")
      }

      try {
        const response = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: "Write a story about a magic backpack.",
        });
        const text = response.text();

        console.log(text);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: text });
      } catch (error) {
        console.error("Error generating text:", error);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error generating text."});
      }
    }
  },
});