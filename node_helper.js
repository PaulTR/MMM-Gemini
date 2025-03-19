const NodeHelper = require("node_helper");
const { GoogleGenAI } = require("@google/genai");

module.exports = NodeHelper.create({
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
      console.log(apiKey)
      
      const ai = new GoogleGenAI({ apiKey: apiKey });

        const response = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: "Write a joke about a magic backpack. Keep it under 40 words",
        });

        console.log(response.text);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });
      }
    }
  },
);