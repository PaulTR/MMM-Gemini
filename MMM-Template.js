/* global Module, Log, Buffer */ // Added Buffer for potential browser audio playback later

Module.register("MMM-Template", {
  defaults: {
    // Display content
    statusText: "Initializing...",
    apiKey: "", // MUST be set in config.js
    // --- REMOVED triggerInterval and recordingDuration ---
    // Visual feedback
    showIndicators: true,
    // Simplified indicators
    initializingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="grey" /><circle cx="50" cy="50" r="30" fill="white" /><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="1.5s" repeatCount="indefinite"/></svg>`, // Spinning ring
    recordingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"><animate attributeName="r" dur="1.2s" values="35;40;35" repeatCount="indefinite" /></circle></svg>`, // Pulsing red circle
    errorIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#333" /><line x1="30" y1="30" x2="70" y2="70" stroke="red" stroke-width="10" /><line x1="70" y1="30" x2="30" y2="70" stroke="red" stroke-width="10" /></svg>`, // Red X on dark grey
    // --- REMOVED processingIndicatorSvg ---
    lastResponsePrefix: "Mirror says: ",
    debug: false, // Set to true for more verbose logging
  },

  // --- Module State ---
  // Simplified States: INITIALIZING, READY, RECORDING, ERROR, SHUTDOWN
  currentState: "INITIALIZING",
  currentStatusText: "",
  lastResponseText: "", // Stores text representation or indicator for audio
  helperReady: false,
  // --- REMOVED triggerTimer ---

  // --- Lifecycle Functions ---
  start() {
    Log.info(`Starting module: ${this.name}`);
    this.currentStatusText = this.config.statusText;
    this.currentState = "INITIALIZING";
    this.helperReady = false;
    this.lastResponseText = "";

    if (!this.config.apiKey) {
      Log.error(`${this.name}: apiKey not set in config! Module disabled.`);
      this.currentStatusText = "Error: API Key missing in config.js.";
      this.currentState = "ERROR";
      this.updateDom();
      return; // Stop initialization
    }

    // Send API key to helper immediately, it will initialize asynchronously
    this.sendSocketNotification("START_CONNECTION", {
            apiKey: this.config.apiKey,
            debug: this.config.debug // Pass debug flag to helper
        });

    // Update DOM to show "Initializing..."
    this.updateDom();
  },

  // --- DOM Generation ---
  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-template-wrapper normal medium"; // Added MM classes

    let indicator = "";
    if (this.config.showIndicators) {
      switch (this.currentState) {
        case "INITIALIZING":
        case "READY": // Show initializing briefly while telling helper to start
            indicator = this.config.initializingIndicatorSvg;
            break;
        case "RECORDING":
          indicator = this.config.recordingIndicatorSvg;
          break;
        case "ERROR":
            indicator = this.config.errorIndicatorSvg;
            break;
        // case "PROCESSING": // Removed state
        // case "LISTENING": // Replaced by RECORDING
        case "SHUTDOWN": // Optional: show nothing or idle indicator
             indicator = ""; // Or this.config.idleIndicatorSvg if defined
             break;
        default: // Should not happen often
          indicator = this.config.errorIndicatorSvg; // Show error on unknown state
          break;
      }
    }

    const statusDiv = document.createElement("div");
    statusDiv.className = "status-indicator bright"; // Added MM classes
    statusDiv.style.display = "inline-block"; // Keep indicator inline
    statusDiv.style.verticalAlign = "middle"; // Align indicator vertically
    statusDiv.innerHTML = indicator;

        const textDiv = document.createElement("div");
        textDiv.className = "status-text";
        textDiv.style.marginLeft = "10px"; // Space between indicator and text
        textDiv.style.display = "inline-block"; // Keep text next to indicator
        textDiv.style.verticalAlign = "middle"; // Align text vertically

    const currentStatusSpan = document.createElement("div");
    currentStatusSpan.className = "current-status bright";
    currentStatusSpan.innerHTML = this.currentStatusText;

    const responseSpan = document.createElement("div");
    responseSpan.className = "response-text small dimmed"; // Added MM classes
    responseSpan.style.marginTop = "5px"; // Space above response text
    // Show response only if not initializing/erroring and there is text
    if ((this.currentState === "RECORDING") && this.lastResponseText) {
       responseSpan.innerHTML = `${this.config.lastResponsePrefix}${this.lastResponseText}`;
    } else {
       responseSpan.innerHTML = "";
    }


        textDiv.appendChild(currentStatusSpan);
        textDiv.appendChild(responseSpan);

    // Append indicator only if it's not empty
    if (indicator) {
       wrapper.appendChild(statusDiv);
    }
    wrapper.appendChild(textDiv);


    return wrapper;
  },

    getStyles: function() {
        return ["MMM-Template.css"]; // Optional: Link to a CSS file for styling
    },

  // --- Socket Notifications ---
  socketNotificationReceived: function (notification, payload) {
    if (this.config.debug) {
            Log.log(`${this.name} received notification: ${notification}`, payload || ""); // Debug log
        }

    switch (notification) {
      case "HELPER_READY":
                if (!this.helperReady) { // Prevent multiple triggers
                    Log.info(`${this.name}: Helper is ready. Requesting continuous recording start.`);
                    this.helperReady = true;
                    this.currentState = "READY"; // Transient state
                    this.currentStatusText = "Starting microphone...";
                    this.lastResponseText = ""; // Clear response on ready
                    this.updateDom(); // Show status update
                    // *** Tell helper to start recording ***
                    this.sendSocketNotification("START_CONTINUOUS_RECORDING");
                } else {
                     Log.warn(`${this.name}: Received duplicate HELPER_READY notification. Ignored.`);
                }
        break;
      case "RECORDING_STARTED":
        Log.info(`${this.name}: Continuous recording confirmed by helper.`);
        this.currentState = "RECORDING";
        this.currentStatusText = "Listening...";
        // Do not clear last response here, allow it to persist until next response
        break;
      case "RECORDING_STOPPED":
                // This usually means an error occurred, unless we are stopping the module
                if (this.currentState !== "SHUTDOWN") {
                    Log.warn(`${this.name}: Recording stopped unexpectedly.`);
                    this.currentState = "ERROR"; // Assume error if stopped unexpectedly
                    this.currentStatusText = "Mic stopped. Check logs.";
                    this.helperReady = false; // Assume connection needs reset
                } else {
                    Log.info(`${this.name}: Recording stopped as part of shutdown.`);
                }
        break;
            // case "AUDIO_SENT": // Removed - not needed for UI state
                 // if (this.config.debug) Log.log(`${this.name}: Helper sent audio chunk.`);
                 // break;
      case "GEMINI_RESPONSE":
                // Stay in RECORDING state, just update the text
                if (this.currentState !== "RECORDING") {
                     Log.warn(`${this.name}: Received Gemini response while not in RECORDING state (${this.currentState}). Updating text anyway.`);
                }
        if (payload && (payload.text || payload.audio || payload.feedback)) {
                     if (payload.text) {
                         this.lastResponseText = payload.text;
                         Log.info(`${this.name} received text: ${payload.text}`);
                     } else if (payload.audio) {
                         this.lastResponseText = "[Audio response received]";
                         Log.info(`${this.name} received audio response.`);
                         // Optional: Browser audio playback (less likely needed for MM)
                         // try {
                         //     const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                         //     const buffer = Buffer.from(payload.audio, 'base64');
                         //     // Assuming raw PCM S16LE at 24kHz from helper/Gemini
                         //     // This requires careful buffer manipulation to make playable in browser
                         //     // It's generally easier to let the helper handle playback via Speaker
                         // } catch (e) {
                         //     Log.error(`${this.name}: Error playing audio in browser:`, e);
                         // }
                     } else if (payload.feedback) {
                         // Display feedback if no other text/audio was provided
                          const reason = payload.feedback.blockReason || "Unknown feedback";
                          this.lastResponseText = `[Feedback: ${reason}]`;
                          Log.warn(`${this.name} received prompt feedback: ${reason}`);
                     }
                } else {
                    this.lastResponseText = "[Empty response]";
                     Log.warn(`${this.name}: Received GEMINI_RESPONSE notification but no actionable payload.`);
                }
                // *** DO NOT schedule next trigger - recording is continuous ***
        break;
      case "HELPER_ERROR":
        this.currentState = "ERROR";
        this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`;
        Log.error(`${this.name} received error from helper: ${payload.error}`);
                this.helperReady = false; // Assume connection needs reset
                this.lastResponseText = ""; // Clear response on error
        break;
            case "HELPER_LOG": // For receiving debug logs from helper
                Log.log(`NodeHelper (${this.name}): ${payload}`);
                break;
    }
    // Update display after handling any notification
    this.updateDom();
  },

  // --- REMOVED Custom Methods ---
  // scheduleNextTrigger() - Removed
  // triggerRecording() - Removed

  // --- Stop ---
  stop: function() {
    Log.info(`Stopping module: ${this.name}`);
    this.currentState = "SHUTDOWN";
    this.currentStatusText = "Shutting down...";
    this.helperReady = false;
    this.updateDom(); // Show shutting down state

        // Notify helper to clean up its resources (stop recording, close connection)
        Log.info(`${this.name}: Sending STOP_CONNECTION notification.`);
    this.sendSocketNotification("STOP_CONNECTION");
  }

});