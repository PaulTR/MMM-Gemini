/* global Module, Log, Buffer */ // Added Buffer for potential browser audio playback later

Module.register("MMM-Template", {
  defaults: {
    // Display content
    statusText: "Initializing...",
    apiKey: "", // MUST be set in config.js
    
    // Visual feedback
    showIndicators: true,
    
    // Simplified indicators
    // Spinning ring
    initializingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="grey" /><circle cx="50" cy="50" r="30" fill="white" /><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="1.5s" repeatCount="indefinite"/></svg>`,    
    // Pulsing red circle
    recordingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"><animate attributeName="r" dur="1.2s" values="35;40;35" repeatCount="indefinite" /></circle></svg>`,
     // Red X on dark grey
    errorIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#333" /><line x1="30" y1="30" x2="70" y2="70" stroke="red" stroke-width="10" /><line x1="70" y1="30" x2="30" y2="70" stroke="red" stroke-width="10" /></svg>`,
  },

  // --- Module State ---
  // Simplified States: INITIALIZING, READY, RECORDING, ERROR, SHUTDOWN
  currentState: "INITIALIZING",
  currentStatusText: "",
  lastResponseText: "", // Stores text representation or indicator for audio
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

    // Send API key to helper immediately, it will initialize asynchronously
    this.sendSocketNotification("START_CONNECTION", {
            apiKey: this.config.apiKey,
        })

    // Update DOM to show "Initializing..."
    this.updateDom()
  },

  getDom() {
    const wrapper = document.createElement("div")
    wrapper.className = "mmm-template-gemini"

    let indicator = ""
    if (this.config.showIndicators) {
      switch (this.currentState) {
        case "INITIALIZING":
        case "READY": // Show initializing briefly while telling helper to start
            indicator = this.config.initializingIndicatorSvg
            break
        case "RECORDING":
          indicator = this.config.recordingIndicatorSvg
          break
        case "ERROR":
            indicator = this.config.errorIndicatorSvg
            break
        // TODO decide if I even want to keep this
        case "SHUTDOWN": // Optional: show nothing or idle indicator
             indicator = "" // Or this.config.idleIndicatorSvg if defined
             break
        default: // Should not happen often - 'often' needed because lol
          indicator = this.config.errorIndicatorSvg
          break
      }
    }

    // Move all of this into CSS file
    const statusDiv = document.createElement("div")
    statusDiv.className = "status-indicator" // Added MM classes
    statusDiv.style.verticalAlign = "middle" // Align indicator vertically
    responseSpan.style.marginTop = "-25px"
    statusDiv.innerHTML = indicator

    const textDiv = document.createElement("div")
    textDiv.className = "status-label"
    // textDiv.style.marginLeft = "10px" // Space between indicator and text
    // textDiv.style.verticalAlign = "middle" // Align text vertically

    const currentStatusSpan = document.createElement("div")
    currentStatusSpan.className = "current-status"
    currentStatusSpan.innerHTML = this.currentStatusText

    const responseSpan = document.createElement("div")
    // responseSpan.className = "response-text small dimmed" // Added MM classes
    responseSpan.className = "response" // Added MM classes
    // responseSpan.style.marginTop = "5px" // Space above response text
    
    // Show response only if not initializing/erroring and there is text
    if ((this.currentState === "RECORDING") && this.lastResponseText) {
       responseSpan.innerHTML = `${this.lastResponseText}`
    } else {
       responseSpan.innerHTML = ""
    }


    textDiv.appendChild(currentStatusSpan)
    textDiv.appendChild(responseSpan)

    wrapper.appendChild(textDiv)

    // wrapper.appendChild(document.createElement("br"))
    // wrapper.appendChild(document.createElement("br"))

    // Append indicator only if it's not empty
    if (indicator) {
       wrapper.appendChild(statusDiv)
    }

    return wrapper
  },

  getStyles: function() {
      return ["MMM-Template.css"] // Optional
  },

  // This is the function used for receiving messages back from node_helper.js
  socketNotificationReceived: function (notification, payload) {
    switch (notification) {
      case "HELPER_READY":
        if (!this.helperReady) {
            Log.info(`${this.name}: Helper is ready. Requesting continuous recording start.`)
            this.helperReady = true
            this.currentState = "READY"
            this.currentStatusText = "Starting microphone..."
            this.lastResponseText = ""
            this.updateDom()
            
            // *** Tell helper to start recording ***
            this.sendSocketNotification("START_CONTINUOUS_RECORDING")
        } else {
             Log.warn(`${this.name}: Received duplicate HELPER_READY notification. Ignored.`)
        }
        break
      case "RECORDING_STARTED":
        Log.info(`${this.name}: Continuous recording confirmed by helper.`)
        this.currentState = "RECORDING"
        this.currentStatusText = "Listening..."
        break
      case "RECORDING_STOPPED":
        // This usually means an error occurred, unless we are stopping the module
        if (this.currentState !== "SHUTDOWN") {
            Log.warn(`${this.name}: Recording stopped unexpectedly.`)
            this.currentState = "ERROR" // Assume error if stopped unexpectedly
            this.currentStatusText = "Mic stopped. Check logs."
            this.helperReady = false // Assume connection needs reset
        } else {
            Log.info(`${this.name}: Recording stopped as part of shutdown.`)
        }
        break
      case "GEMINI_TEXT_RESPONSE":
        if( this.turnComplete ) {
          this.lastResponseText = payload.text
          this.turnComplete = false
        } else {
          this.lastResponseText = `${this.lastResponseText}${payload.text}`
        }
        
        Log.info(`${this.name} received text: ${payload.text}`)
        break
      case "GEMINI_TURN_COMPLETE":
        this.turnComplete = true
        break
      case "HELPER_ERROR":
        this.currentState = "ERROR"
        this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`
        Log.error(`${this.name} received error from helper: ${payload.error}`)
        this.helperReady = false // Assume connection needs reset
        this.lastResponseText = "" // Clear response on error
        break
    }

    this.updateDom()
  },
})