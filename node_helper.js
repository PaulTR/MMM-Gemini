const NodeHelper = require("node_helper")
const { GoogleGenerativeAI } = require("@google/generative-ai");


module.exports = NodeHelper.create({

  async socketNotificationReceived(notification, payload) {
    if (notification === "GET_RANDOM_TEXT") {
      const amountCharacters = payload.amountCharacters || 10
      const randomText = Array.from({ length: amountCharacters }, () => String.fromCharCode(Math.floor(Math.random() * 26) + 97)).join("")
      this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText })
    }
    if( notification === "GENERATE_TEXT") {
      const apiKey = payload.apikey
      
      const ai = new GoogleGenAI({ apiKey: apiKey });

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "Write a story about a magic mirror.",
      });

      console.log(response.text);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text })
    }
  },
})
