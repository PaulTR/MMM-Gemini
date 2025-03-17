const NodeHelper = require("node_helper")

module.exports = NodeHelper.create({

  import { GoogleGenAI } from "@google/genai";
  
  async socketNotificationReceived(notification, payload) {
    if (notification === "GET_RANDOM_TEXT") {
      const amountCharacters = payload.amountCharacters || 10
      const randomText = Array.from({ length: amountCharacters }, () => String.fromCharCode(Math.floor(Math.random() * 26) + 97)).join("")
      this.sendSocketNotification("EXAMPLE_NOTIFICATION", { text: randomText })
    }

    if( notification === "GENERATE_TEXT" ) {
      this.sendSocketNotification("EAMPLE_NOTIFICATION", { text: "TEST GENERATE TEXT" })
    }
  },
})
