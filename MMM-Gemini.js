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
  helperReady: false,
  turnComplete: true,

  // --- Lifecycle Functions ---
  start() {
    Log.info(`Starting module: ${this.name}`);
    this.currentStatusText = this.config.statusText;
    this.currentState = "INITIALIZING";
    this.helperReady = false;
    this.lastResponseText = "";
    this.lastImageData = null; // <-- ADDED: Initialize image data

    if (!this.config.apiKey) {
      Log.error(`${this.name}: apiKey not set in config! Module disabled.`);
      this.currentStatusText = "Error: API Key missing in config.js.";
      this.currentState = "ERROR";
      this.updateDom();
      return;
    }

    this.sendSocketNotification("START_CONNECTION", {
      apiKey: this.config.apiKey,
    });
    this.updateDom();
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-gemini";

    // --- Create Indicator --- (Remains the same)
    let indicatorSvg = "";
    if (this.config.showIndicators) {
      switch (this.currentState) {
        case "INITIALIZING":
        case "READY":
          indicatorSvg = this.config.initializingIndicatorSvg;
          break;
        case "RECORDING":
          indicatorSvg = this.config.recordingIndicatorSvg;
          break;
        case "ERROR":
          indicatorSvg = this.config.errorIndicatorSvg;
          break;
        case "SHUTDOWN":
          indicatorSvg = "";
          break;
        default:
          indicatorSvg = this.config.errorIndicatorSvg;
          break;
      }
    }

    const statusDiv = document.createElement("div");
    statusDiv.className = "status-indicator";
    statusDiv.innerHTML = indicatorSvg;

    wrapper.appendChild(statusDiv); // Add indicator first

    // --- Create Main Content Area (Image + Text) ---
    const contentDiv = document.createElement("div");
    contentDiv.className = "content-container"; // Container for image and text

    // --- ADDED: Image Element (if available) ---
    const imageContainer = document.createElement("div");
    imageContainer.className = "image-container"; // Class for styling

    if (this.lastImageData) {
      const imageElement = document.createElement("img");
      imageElement.className = "generated-image"; // Class for styling
      // Construct the data URI (Assuming PNG, adjust mime type if needed e.g., image/jpeg)
      imageElement.src = `data:image/png;base64,${this.lastImageData}`;
      // Add some basic inline styles (or preferably use CSS)
      imageElement.style.display = "block";     // Ensure it takes block space
      imageElement.style.maxWidth = "90%";      // Limit width relative to container
      imageElement.style.maxHeight = "300px";   // Limit height (adjust as needed)
      imageElement.style.margin = "0 auto 10px auto"; // Center horizontally, add bottom margin
      imageContainer.appendChild(imageElement);
      imageContainer.style.display = '';        // Show the container
    } else {
      imageContainer.style.display = 'none';    // Hide the container if no image
    }
    contentDiv.appendChild(imageContainer); // Add image container first within contentDiv

    // --- Text Elements --- (Wrapped in their own div for structure)
    const textDiv = document.createElement("div");
    textDiv.className = "text-container";

    // Current Status Text (Remains the same)
    const currentStatusSpan = document.createElement("div");
    currentStatusSpan.className = "current-status";
    currentStatusSpan.innerHTML = this.currentStatusText || "&nbsp;";
    textDiv.appendChild(currentStatusSpan);

    // Response Text (Remains the same)
    const responseSpan = document.createElement("div");
    responseSpan.className = "response";

    // Display response text only when appropriate (listening or ready states after a response)
    if ((this.currentState === "RECORDING" || this.currentState === "READY") && this.lastResponseText) {
      responseSpan.innerHTML = `${this.lastResponseText}`;
      responseSpan.style.display = '';
    } else {
      responseSpan.innerHTML = "&nbsp;";
      responseSpan.style.display = 'none'; // Hide if no text or in other states
    }

    textDiv.appendChild(responseSpan);

    contentDiv.appendChild(textDiv); // Add text container after image container

    wrapper.appendChild(contentDiv); // Add the combined content container to the main wrapper

    return wrapper;
  },


  getStyles: function() {
      return ["MMM-Gemini.css"];
  },

  socketNotificationReceived: function (notification, payload) {
    // Reset display text/image if needed when state changes or errors occur
    let shouldClearResponse = false;

    switch (notification) {
      case "HELPER_READY":
        if (!this.helperReady) {
            Log.info(`${this.name}: Helper is ready. Requesting continuous recording start.`);
            this.helperReady = true;
            this.currentState = "READY";
            this.currentStatusText = "Starting microphone...";
            shouldClearResponse = true; // Clear previous response/image
            this.updateDom(); // Update before sending notification

            this.sendSocketNotification("START_CONTINUOUS_RECORDING");
        } else {
             Log.warn(`${this.name}: Received duplicate HELPER_READY notification. Ignored.`);
        }
        break;
      case "RECORDING_STARTED":
        Log.info(`${this.name}: Continuous recording confirmed by helper.`);
        this.currentState = "RECORDING";
        this.currentStatusText = "Listening...";
        shouldClearResponse = true; // Clear previous response/image when listening starts
        break;
      case "RECORDING_STOPPED":
        if (this.currentState !== "SHUTDOWN") {
            Log.warn(`${this.name}: Recording stopped unexpectedly.`);
            this.currentState = "ERROR";
            this.currentStatusText = "Mic stopped. Check logs.";
            this.helperReady = false;
            shouldClearResponse = true; // Clear previous response/image
        } else {
            Log.info(`${this.name}: Recording stopped as part of shutdown.`);
        }
        break;
      case "GEMINI_TEXT_RESPONSE":
        this.currentStatusText = "";
        if ( this.turnComplete ) {
          this.lastResponseText = payload.text; // Start new response
          this.lastImageData = null;
          this.turnComplete = false;
        } else {
          this.lastResponseText = `${this.lastResponseText}${payload.text}`; // Append chunk
        }
        Log.info(`${this.name} received text chunk.`); // Log less verbosely for chunks
        break;
      case "GEMINI_TURN_COMPLETE":
        this.turnComplete = true;
        this.currentStatusText = "Listening..."; // Go back to listening status
        // Keep the text and image displayed until next interaction starts
        break;
      case "HELPER_ERROR":
        this.currentState = "ERROR";
        this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`;
        Log.error(`${this.name} received error from helper: ${payload.error}`);
        this.helperReady = false;
        shouldClearResponse = true; // Clear previous response/image
        break;

      case "GEMINI_IMAGE_GENERATED":
        Log.info(`${this.name}: Received generated image data.`);
        if (payload && payload.image) {
            this.lastImageData = payload.image
            this.lastResponseText = this.lastResponseText || ""
            this.currentStatusText = "Listening..."
        } else {
            Log.warn(`${this.name}: Received GEMINI_IMAGE_GENERATED but payload or image data was missing.`);
            this.lastImageData = null; // Ensure it's cleared if payload is bad
        }
        break;

      default:
          Log.warn(`${this.name} received unhandled notification: ${notification}`);
          break;
    }

    // Clear response text and image if needed (e.g., on state change, error, new recording start)
    if (shouldClearResponse) {
        this.lastResponseText = "";
        this.lastImageData = null;
    }

    this.updateDom(); // Update DOM after processing notification
  },
});