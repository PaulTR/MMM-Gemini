const NodeHelper = require("node_helper");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Use gemini-pro or gemini-pro-vision

      try {
        const result = await model.generateContent("Write a story about a magic mirror.");
        const response = await result.response;
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