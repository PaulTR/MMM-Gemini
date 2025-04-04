Module.register("MMM-Template", {
  defaults: {
    statusText: "Initializing...",
    apiKey: "", // MUST be set in config.js

    showIndicators: true,

    initializingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="white"><animate attributeName="r" dur="1.2s" values="35;40;35" repeatCount="indefinite" /></circle></svg>`,
    recordingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"><animate attributeName="r" dur="1.2s" values="35;40;35" repeatCount="indefinite" /></circle></svg>`,
    errorIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#333" /><line x1="30" y1="30" x2="70" y2="70" stroke="red" stroke-width="10" /><line x1="70" y1="30" x2="30" y2="70" stroke="red" stroke-width="10" /></svg>`,
  },

  currentState: "INITIALIZING",
  currentStatusText: "",
  lastResponseText: "",
  helperReady: false,
  turnComplete: true,

  // --- Lifecycle Functions ---
  start() {
    Log.info(`Starting module: ${this.name}`)
    this.currentStatusText = this.config.statusText
    this.currentState = "INITIALIZING"
    this.helperReady = false
    this.lastResponseText = ""

    if (!this.config.apiKey) {
      Log.error(`${this.name}: apiKey not set in config! Module disabled.`)
      this.currentStatusText = "Error: API Key missing in config.js."
      this.currentState = "ERROR"
      this.updateDom()
      return
    }

    this.sendSocketNotification("START_CONNECTION", {
            apiKey: this.config.apiKey,
        })
    this.updateDom()
  },

  getDom() {
    const wrapper = document.createElement("div")
    wrapper.className = "mmm-template-gemini"

    const textDiv = document.createElement("div")
    textDiv.className = "text-container"

    // Current Status Text
    const currentStatusSpan = document.createElement("div")
    currentStatusSpan.className = "current-status"
    currentStatusSpan.innerHTML = this.currentStatusText || "&nbsp;"
    textDiv.appendChild(currentStatusSpan)

    // Response Text (if in Modality.TEXT mode)
    const responseSpan = document.createElement("div")
    responseSpan.className = "response"
    
    if ((this.currentState === "RECORDING" || this.currentState === "READY") && this.lastResponseText) {
       responseSpan.innerHTML = `${this.lastResponseText}`
       responseSpan.style.display = ''
    } else {
       responseSpan.innerHTML = "&nbsp;"
       responseSpan.style.display = 'none'
    }

    textDiv.appendChild(responseSpan)

    // --- Create Indicator ---
    let indicatorSvg = ""
    if (this.config.showIndicators) {
      switch (this.currentState) {
        case "INITIALIZING":
        case "READY":
            indicatorSvg = this.config.initializingIndicatorSvg
            break
        case "RECORDING":
          indicatorSvg = this.config.recordingIndicatorSvg
          break
        case "ERROR":
            indicatorSvg = this.config.errorIndicatorSvg
            break
        case "SHUTDOWN":
             indicatorSvg = ""
             break
        default:
          indicatorSvg = this.config.errorIndicatorSvg
          break
      }
    }

    const statusDiv = document.createElement("div")
    statusDiv.className = "status-indicator"
    statusDiv.innerHTML = indicatorSvg

    wrapper.appendChild(statusDiv)
    wrapper.appendChild(textDiv)


    return wrapper
  },


  getStyles: function() {
      return ["MMM-Template.css"]
  },

  socketNotificationReceived: function (notification, payload) {
    // Reset display text if needed when state changes
    let shouldClearResponse = false

    switch (notification) {
      case "HELPER_READY":
        if (!this.helperReady) {
            Log.info(`${this.name}: Helper is ready. Requesting continuous recording start.`)
            this.helperReady = true
            this.currentState = "READY"
            this.currentStatusText = "Starting microphone..."
            shouldClearResponse = true
            this.updateDom() // Update before sending notification

            this.sendSocketNotification("START_CONTINUOUS_RECORDING")
        } else {
             Log.warn(`${this.name}: Received duplicate HELPER_READY notification. Ignored.`)
        }
        break
      case "RECORDING_STARTED":
        Log.info(`${this.name}: Continuous recording confirmed by helper.`)
        this.currentState = "RECORDING"
        this.currentStatusText = "Listening..."
        shouldClearResponse = true // Clear previous response when listening starts
        break
      case "RECORDING_STOPPED":
        if (this.currentState !== "SHUTDOWN") {
            Log.warn(`${this.name}: Recording stopped unexpectedly.`)
            this.currentState = "ERROR"
            this.currentStatusText = "Mic stopped. Check logs."
            this.helperReady = false
            shouldClearResponse = true
        } else {
            Log.info(`${this.name}: Recording stopped as part of shutdown.`)
        }
        break
      case "GEMINI_TEXT_RESPONSE":
        this.currentStatusText = ""
        if( this.turnComplete ) {
          this.lastResponseText = payload.text // Start new response
          this.turnComplete = false
        } else {
          this.lastResponseText = `${this.lastResponseText}${payload.text}` // Append chunk
        }
        Log.info(`${this.name} received text: ${payload.text}`)
        break
      case "GEMINI_TURN_COMPLETE":
        this.turnComplete = true
        this.currentStatusText = "Listening..."
        break
      case "HELPER_ERROR":
        this.currentState = "ERROR"
        this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`
        Log.error(`${this.name} received error from helper: ${payload.error}`)
        this.helperReady = false
        shouldClearResponse = true
        break
      default:
          Log.warn(`${this.name} received unhandled notification: ${notification}`)
          break 
    }

    // Clear response text if needed (e.g., on state change, error)
    if (shouldClearResponse) {
        this.lastResponseText = ""
    }

    this.updateDom() // Update DOM after processing notification
  },
})