const NodeHelper = require("node_helper");
const { GoogleGenAI } = require("@google/genai");

module.exports = NodeHelper.create({

  genAI: null, // Initialize genAI as null

  initializeGenAI: function(apiKey) {
    if (!this.genAI) {
      console.log("initializing!")
      this.genAI = new GoogleGenAI({ apiKey: apiKey });
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
      const apiKey = payload.apikey;
      this.initializeGenAI(apiKey);

      const response = await this.genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "Write a joke about a magic backpack. Keep it under 40 words",
      });

      console.log(response.text);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });
    }

    if( notification === "START_CHAT" ) {
      const apiKey = payload.apikey;
      this.initializeGenAI(apiKey);

      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Starting chat"})

      
    }
  },
});