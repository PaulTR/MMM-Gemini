/* global Module, Log */

Module.register("MMM-Template", {
  defaults: {
    // Display content
    statusText: "Initializing...",
    apiKey: "", // MUST be set in config.js
    // Trigger configuration
    triggerInterval: 7000, // Time between recording triggers in ms (e.g., 7s). Must be longer than recordingDuration.
    recordingDuration: 3000, // How long node_helper should record in ms (e.g., 3s).
    // Visual feedback
    showIndicators: true,
    idleIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="grey" /></svg>`,
    recordingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"><animate attributeName="opacity" dur="1s" values="0.5;1;0.5" repeatCount="indefinite" /></circle></svg>`,
    processingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="orange"><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="2s" repeatCount="indefinite"/></svg>`, // Rotating orange
    errorIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#333" /><line x1="30" y1="30" x2="70" y2="70" stroke="red" stroke-width="10" /><line x1="70" y1="30" x2="30" y2="70" stroke="red" stroke-width="10" /></svg>`, // Red X on dark grey
    lastResponsePrefix: "Mirror says: ",
    debug: false, // Set to true for more verbose logging in the browser console
  },

  // --- Module State ---
  currentState: "INITIALIZING", // INITIALIZING, IDLE, LISTENING, PROCESSING, ERROR
  currentStatusText: "",
  lastResponseText: "", // Stores text representation, even for audio
  triggerTimer: null,
  helperReady: false,

  // --- Lifecycle Functions ---
  start() {
    Log.info(`Starting module: ${this.name}`);
    this.currentStatusText = this.config.statusText;
    this.currentState = "INITIALIZING";
    this.helperReady = false;

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

    // We wait for the HELPER_READY notification before scheduling the first trigger.
    this.updateDom();
  },

  // --- DOM Generation ---
  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-template-wrapper normal medium"; // Added MM classes

    let indicator = "";
    if (this.config.showIndicators) {
      switch (this.currentState) {
        case "LISTENING":
          indicator = this.config.recordingIndicatorSvg;
          break;
        case "PROCESSING":
          indicator = this.config.processingIndicatorSvg;
          break;
        case "ERROR":
            indicator = this.config.errorIndicatorSvg;
            break;
        case "IDLE":
        case "INITIALIZING": // Can show idle state while initializing backend
        default:
          indicator = this.config.idleIndicatorSvg;
          break;
      }
    }

    const statusDiv = document.createElement("div");
    statusDiv.className = "status-indicator bright"; // Added MM classes
    statusDiv.innerHTML = indicator;

        const textDiv = document.createElement("div");
        textDiv.className = "status-text";
        textDiv.style.marginLeft = "10px"; // Space between indicator and text
        textDiv.style.display = "inline-block"; // Keep text next to indicator

    const currentStatusSpan = document.createElement("div");
    currentStatusSpan.className = "current-status bright";
    currentStatusSpan.innerHTML = this.currentStatusText;

    const responseSpan = document.createElement("div");
    responseSpan.className = "response-text small dimmed"; // Added MM classes
    responseSpan.style.marginTop = "5px"; // Space above response text
    responseSpan.innerHTML = this.lastResponseText
      ? `${this.config.lastResponsePrefix}${this.lastResponseText}`
      : ""; // Only show if there's a response

        textDiv.appendChild(currentStatusSpan);
        textDiv.appendChild(responseSpan);

    wrapper.appendChild(statusDiv);
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
                if (!this.helperReady) { // Prevent multiple initializations of the timer
                    Log.info(`${this.name}: Helper is ready and connection is open.`);
                    this.helperReady = true;
                    this.currentState = "IDLE";
                    this.currentStatusText = "Ready.";
                    this.scheduleNextTrigger(); // Start the recording loop now that the helper confirmed readiness
                } else {
                     Log.warn(`${this.name}: Received duplicate HELPER_READY notification.`);
                }
        break;
      case "RECORDING_STARTED":
        this.currentState = "LISTENING";
        this.currentStatusText = "Listening...";
        this.lastResponseText = ""; // Clear previous response when starting new recording
        break;
      case "RECORDING_STOPPED":
        // Transition to PROCESSING immediately after recording stops
                // This state remains until a response or error occurs
        this.currentState = "PROCESSING";
        this.currentStatusText = "Processing audio...";
        break;
            case "AUDIO_SENT": // Helper confirms audio chunk was sent
                 if (this.currentState === "LISTENING") { // Should transition after last chunk
                      this.currentState = "PROCESSING";
                      this.currentStatusText = "Waiting for response...";
                 }
                 // Optionally update DOM or log for debugging
                 // Log.log(`${this.name}: Helper confirmed sending audio chunk.`);
                 break;
      case "GEMINI_RESPONSE":
        this.currentState = "IDLE"; // Back to idle after getting response
        this.currentStatusText = "Ready."; // Ready for next trigger
        if (payload && payload.text) { // Check if helper provided transcribed text
          this.lastResponseText = payload.text;
          Log.info(`${this.name} received text transcription: ${payload.text}`);
        } else if (payload && payload.audio) {
                     // Indicate that audio was received, even if not playing it here
                     this.lastResponseText = "[Audio response received]";
           Log.info(`${this.name} received audio response (playback handled by helper or external).`);
                     // If you wanted to play audio in the browser (less common for MM):
                     // const audioBlob = new Blob([Buffer.from(payload.audio, 'base64')], { type: 'audio/l16;rate=16000' }); // Adjust MIME type if needed
                     // const audioUrl = URL.createObjectURL(audioBlob);
                     // const audio = new Audio(audioUrl);
                     // audio.play();
        } else {
                    this.lastResponseText = "[Empty or unknown response]";
                     Log.warn(`${this.name} received GEMINI_RESPONSE notification but no text or audio payload.`);
                }
                // IMPORTANT: Schedule the next trigger AFTER processing the response
                this.scheduleNextTrigger();
        break;
      case "HELPER_ERROR":
        this.currentState = "ERROR";
        this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`;
        Log.error(`${this.name} received error from helper: ${payload.error}`);
                this.helperReady = false; // Assume connection needs reset
        // Stop trying to trigger recordings on error
        clearTimeout(this.triggerTimer);
        this.triggerTimer = null;
        break;
            case "HELPER_LOG": // For receiving debug logs from helper
                Log.log(`NodeHelper (${this.name}): ${payload}`);
                break;

    }
    this.updateDom(); // Update display after handling notification
  },

  // --- Custom Methods ---
  scheduleNextTrigger() {
    clearTimeout(this.triggerTimer); // Clear any existing timer

    // Only schedule if helper is ready and we are currently idle
    if (this.helperReady && this.currentState === "IDLE") {
      if (this.config.debug) {
                Log.log(`${this.name}: Scheduling next recording trigger in ${this.config.triggerInterval} ms.`);
            }
      this.triggerTimer = setTimeout(() => {
                // Trigger only if still IDLE when timer fires
                if (this.currentState === "IDLE") {
            this.triggerRecording();
                } else {
                     Log.warn(`${this.name}: Timer fired, but system was not IDLE (${this.currentState}). Skipping trigger.`);
                     // Reschedule immediately if we missed the window due to being busy
                     this.scheduleNextTrigger();
                }
      }, this.config.triggerInterval);
    } else {
      if (!this.helperReady) {
                Log.warn(`${this.name}: Not scheduling trigger, helper not ready.`);
            }
            if (this.currentState !== "IDLE") {
                 if (this.config.debug) Log.log(`${this.name}: Not scheduling trigger, current state is ${this.currentState}`);
            }
             if (this.currentState === "ERROR") {
                 Log.error(`${this.name}: Not scheduling trigger due to ERROR state.`);
             }
    }
  },

  triggerRecording() {
        // Double check state just before sending notification
    if (this.helperReady && this.currentState === "IDLE") {
      Log.info(`${this.name}: Triggering recording on node_helper for ${this.config.recordingDuration}ms.`);
      this.sendSocketNotification("TRIGGER_RECORDING", {
        duration: this.config.recordingDuration // Tell helper how long to record
      });
      // Update state immediately for responsiveness
      this.currentState = "LISTENING"; // Assume listening will start
      this.currentStatusText = "Triggering...";
      this.lastResponseText = ""; // Clear last response
      this.updateDom();
            // Do NOT reschedule trigger here - reschedule happens after response or if trigger skipped
    } else {
      Log.warn(`${this.name}: Skipping trigger recording call. Helper Ready: ${this.helperReady}, State: ${this.currentState}`);
            // If we skipped because we weren't idle, reschedule to try again later
            if (this.helperReady && this.currentState !== "IDLE") {
                 this.scheduleNextTrigger();
            }
    }
  },

  // --- Stop ---
  stop: function() {
    Log.info(`Stopping module: ${this.name}`);
    clearTimeout(this.triggerTimer);
    this.triggerTimer = null;
        this.helperReady = false;
        this.currentState = "SHUTDOWN"; // Use a distinct state if needed
        // Notify helper to clean up
        Log.info(`${this.name}: Sending STOP_CONNECTION notification.`);
    this.sendSocketNotification("STOP_CONNECTION");
  }

});