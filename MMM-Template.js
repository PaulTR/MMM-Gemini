Module.register("MMM-Template", {

  defaults: {
    exampleContent: ""
  },

  /**
   * Apply the default styles.
   */
  getStyles() {
    return ["template.css"]
  },

  /**
   * Pseudo-constructor for our module. Initialize stuff here.
   */
  start() {
    this.templateContent = this.config.exampleContent
    this.apikey = this.config.apikey

    // set timeout for next random text
    // setInterval(() => this.generateImage(), 30000)

    this.startChat()

    setInterval(() => this.sendText(), 10000)

  },

  /**
   * Handle notifications received by the node helper.
   * So we can communicate between the node helper and the module.
   *
   * @param {string} notification - The notification identifier.
   * @param {any} payload - The payload data`returned by the node helper.
   */
  socketNotificationReceived: function (notification, payload) {
    if (notification === "EXAMPLE_NOTIFICATION") {
      this.templateContent = `${this.config.apikey} ${payload.text}`
      this.updateDom()
    }
    if( notification === "NOTIFICATION_GENERATE_TEXT" ) {
      this.templateContent = `${payload.text}`
      this.updateDom()
    }
    if (notification === "NOTIFICATION_GENERATE_IMAGE") {
        this.templateContent = `<img src='${payload.filename}' width='600' height='600' alt='test'>`
        this.updateDom();
    }
  },

  /**
   * Render the page we're on.
   */
  getDom() {
    const wrapper = document.createElement("div")
    wrapper.innerHTML = `${this.templateContent}`

    Log.error(wrapper)
    return wrapper
  },

  addRandomText() {
    this.sendSocketNotification("GET_RANDOM_TEXT", { amountCharacters: 15 })
  },

  generateText() {
    this.sendSocketNotification("GENERATE_TEXT", { apikey: `${this.config.apikey}` })
  },

  generateImage() {
    this.sendSocketNotification("GENERATE_IMAGE", { apikey: `${this.config.apikey}` })
  },

  startChat: async function() {
    this.sendSocketNotification("START_CHAT", { apikey: `${this.config.apikey}` })
  }

  sendText() {
    this.sendSocketNotification("SEND_TEXT", { text: `Tell me a joke about a magic mirror`})
  }
})



  // /**
  //  * This is the place to receive notifications from other modules or the system.
  //  *
  //  * @param {string} notification The notification ID, it is preferred that it prefixes your module name
  //  * @param {number} payload the payload type.
  //  */
  // notificationReceived(notification, payload) {
  //   if (notification === "TEMPLATE_RANDOM_TEXT") {
  //     this.templateContent = `${this.config.exampleContent} ${payload}`
  //     this.updateDom()
  //   }
  // }
