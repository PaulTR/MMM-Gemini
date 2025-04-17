/*
Copyright 2025 Paul Trebilcox-Ruiz

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
Module.register("MMM-Gemini", {
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
  lastImageData: null,
  isGeneratingImage: false,
  helperReady: false,
  turnComplete: true,

  // --- Lifecycle Functions ---
  start() {
    Log.info(`Starting module: ${this.name}`)
    this.currentStatusText = this.config.statusText
    this.currentState = "INITIALIZING"
    this.helperReady = false
    this.lastResponseText = ""
    this.lastImageData = null
    this.isGeneratingImage = false

    if (!this.config.apiKey) {
      Log.error(`${this.name}: apiKey not set in config! Module disabled.`)
      this.currentStatusText = "Error: API Key missing in config.js."
      this.currentState = "ERROR"
      this.updateDom()
      return
    }

    this.sendSocketNotification("START_CONNECTION", {
      apiKey: this.config.apiKey,
    });
    this.updateDom()
  },

  getDom() {
    const wrapper = document.createElement("div")
    wrapper.className = "mmm-gemini"

    // --- Create Indicator ---
    let indicatorSvg = "";
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

    // --- Create Main Content Area (Image/Loader + Text) ---
    const contentDiv = document.createElement("div")
    contentDiv.className = "content-container"

    // --- Image / Loader Element ---
    const imageContainer = document.createElement("div")
    imageContainer.className = "image-container"

    // --- UPDATED: Display Loader OR Image OR Nothing ---
    if (this.isGeneratingImage) {
      // Display loader
      const loader = document.createElement("div")
      loader.className = "image-loader" // Class for the rotating square
      imageContainer.appendChild(loader)
      imageContainer.style.display = '' // Show container with loader
    } else if (this.lastImageData) {
      // Display actual image
      const imageElement = document.createElement("img")
      imageElement.className = "generated-image"
      imageElement.src = `data:image/png;base64,${this.lastImageData}` // Assumes PNG
      
      // Basic inline styles (better to use CSS), can fix later
      imageElement.style.display = "block"
      imageElement.style.maxWidth = "90%"
      imageElement.style.maxHeight = "300px" // Adjust as needed
      imageElement.style.margin = "0 auto 10px auto"
      imageContainer.appendChild(imageElement)
      imageContainer.style.display = '' // Show container with image
    } else {
      // Hide container if neither generating nor has image data
      imageContainer.style.display = 'none'
    }
    contentDiv.appendChild(imageContainer) // Add the image container

    // --- Text Elements ---
    const textDiv = document.createElement("div")
    textDiv.className = "text-container"

    const currentStatusSpan = document.createElement("div")
    currentStatusSpan.className = "current-status"
    // Display status text, prioritizing "Generating image..." if applicable
    let displayStatus = this.currentStatusText
    
    if (this.isGeneratingImage && !displayStatus) {
        displayStatus = "Generating image..." // Show generating status if no other status is set
    }

    currentStatusSpan.innerHTML = displayStatus || "&nbsp;"
    textDiv.appendChild(currentStatusSpan)

    const responseSpan = document.createElement("div")
    responseSpan.className = "response"
    if ((this.currentState === "RECORDING" || this.currentState === "READY" || this.currentState === "GENERATING_IMAGE") && this.lastResponseText) {
       responseSpan.innerHTML = `${this.lastResponseText}`
       responseSpan.style.display = ''
    } else {
       responseSpan.innerHTML = "&nbsp;"
       responseSpan.style.display = 'none'
    }
    
    textDiv.appendChild(responseSpan)

    contentDiv.appendChild(textDiv)
    wrapper.appendChild(contentDiv)

    return wrapper
  },


  getStyles: function() {
      return ["MMM-Gemini.css"]
  },

  socketNotificationReceived: function (notification, payload) {
    let shouldClearResponse = false

    switch (notification) {
      case "HELPER_READY":
        if (!this.helperReady) {
            Log.info(`${this.name}: Helper is ready. Requesting continuous recording start.`)
            this.helperReady = true
            this.currentState = "READY"
            this.currentStatusText = "Starting microphone..."
            shouldClearResponse = true
            this.updateDom()

            this.sendSocketNotification("START_CONTINUOUS_RECORDING")
        } else {
             Log.warn(`${this.name}: Received duplicate HELPER_READY notification. Ignored.`)
        }

        break;
      case "RECORDING_STARTED":
        Log.info(`${this.name}: Continuous recording confirmed by helper.`)
        this.currentState = "RECORDING"
        this.currentStatusText = "Listening..."
        shouldClearResponse = true
        break;
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
        break;
      case "GEMINI_TEXT_RESPONSE":
        this.currentStatusText = "" // Clear status like "Listening..."
        if ( this.turnComplete ) {
          this.lastResponseText = payload.text // Start new response
          this.lastImageData = null
          this.isGeneratingImage = false; // Reset flag on new text turn
          this.turnComplete = false
        } else {
          this.lastResponseText = `${this.lastResponseText}${payload.text}` // Append chunk
        }
        Log.info(`${this.name} received text chunk.`)
        break;
      case "GEMINI_TURN_COMPLETE":
        this.turnComplete = true
        // Only set back to Listening if not currently generating an image
        if (!this.isGeneratingImage) {
            this.currentStatusText = "Listening...";
        }
        break
      case "HELPER_ERROR":
        Log.error(`${this.name} received error from helper: ${payload.error}`)
        this.currentState = "ERROR"
        this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`
        this.helperReady = false
        this.isGeneratingImage = false // Reset flag on error
        shouldClearResponse = true
        break

      case "GEMINI_IMAGE_GENERATING":
        Log.info(`${this.name}: Starting image generation.`)
        this.isGeneratingImage = true
        this.lastImageData = null // Clear previous image
        this.currentStatusText = "Generating image..." // Set status text
        // Don't clear lastResponseText
        // updateDom() will be called at the end
        break

      case "GEMINI_IMAGE_GENERATED":
        Log.info(`${this.name}: Received generated image data.`)
        this.isGeneratingImage = false // Turn off loader flag
        if (payload && payload.image) {
            this.lastImageData = payload.image // Store base64 image data
            // If turn was complete, restore Listening status, else clear "Generating..."
             this.currentStatusText = this.turnComplete ? "Listening..." : ""
             // If we added a specific state, reset it
             if (this.currentState === "GENERATING_IMAGE") {
                 this.currentState = this.turnComplete ? "RECORDING" : "READY" // Or determine appropriate previous state
             }
        } else {
            Log.warn(`${this.name}: Received GEMINI_IMAGE_GENERATED but payload or image data was missing.`);
            this.lastImageData = null // Ensure it's cleared if payload is bad
            this.currentStatusText = "Error receiving image" // Show error status
            // If we added a specific state, reset it
             if (this.currentState === "GENERATING_IMAGE") {
                 this.currentState = this.turnComplete ? "RECORDING" : "READY"
             }
        }
        // updateDom() called at the end
        break

      default:
          Log.warn(`${this.name} received unhandled notification: ${notification}`)
          break
    }

    if (shouldClearResponse) {
        this.lastResponseText = ""
        this.lastImageData = null
        this.isGeneratingImage = false
    }

    this.updateDom() // Update DOM after processing notification
  },
});