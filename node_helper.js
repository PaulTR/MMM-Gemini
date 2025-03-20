/* MagicMirror Module: your-module-name
 * By Michael Teeuw https://michaelteeuw.nl
 * MIT Licensed.
 */

Module.register("your-module-name", {
  defaults: {
    apiKey: "", // Set this in config.js!
    model: "gemini-2.0-flash-exp" // Or another suitable model
  },

  requiresVersion: "2.1.0", // Required version of MagicMirror

  audioContext: null,
  recorder: null,
  liveSession: null,
  intervalId: null,

  start: function() {
    Log.info("Starting module: " + this.name);
    this.config.apiKey = this.config.apiKey || "";

    // Schedule visual updates (if needed)
    this.updateDom();

    // Initialize GenAI here (it's okay in a single-file setup)
    this.initializeGenAI(this.config.apiKey);
  },

  getDom: function() {
    var wrapper = document.createElement("div");
    wrapper.id = "my-module-content"; // For easier updates
    wrapper.innerHTML = "Loading...";
    return wrapper;
  },

  getScripts: function() {
    return [
      this.file("recorder.js"), // Path to recorder.js in your module folder
    ];
  },

  getStyles: function() {
    return [
      this.file("your-module-name.css") // Optional CSS
    ];
  },

  socketNotificationReceived: function(notification, payload) {
    switch (notification) {
      case "NOTIFICATION_GENERATE_TEXT":
        Log.log(this.name + ": " + payload.text);
        this.updateContent(payload.text); // Update the DOM with the text
        break;
    }
  },

  updateContent: function(text) {
    var contentDiv = document.getElementById("my-module-content");
    if (contentDiv) {
      contentDiv.innerHTML = text;
    }
  },

  initializeGenAI: function(apiKey) {
    // You'll need to fetch and include the GenAI library in your HTML if
    // you're doing *everything* in one file (which is not recommended).
    // Otherwise, this should really be in node_helper.js

    //Simulate node_helper for single file operation
    this.node_helper = {
      genAI: null,
      initializeGenAI: (apiKey) => {
        if (!this.node_helper.genAI) {
          console.log("initializing!");
          this.node_helper.genAI = new (window.google.generativeai.GoogleGenerativeAI) (apiKey);
        }
      },

      startLiveChat: async () => {
        try {
          const model = this.node_helper.genAI.getGenerativeModel({ model: this.config.model });

          this.liveSession = model.generateStream({
              contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          });

          this.startRecording();

        } catch (error) {
          console.error("Error starting live chat:", error);
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting live chat: " + error.message });
        }
      },

      sendMessage: async (audioData) => {
        try {
          // Convert audioData (Uint8Array) to base64 string
          const base64Audio = btoa(String.fromCharCode.apply(null, audioData));

          // Include the base64Audio data in the prompt
          const prompt = "Please respond to the audio data provided. Here is the base64 representation of the audio: " + base64Audio;

          const model = this.node_helper.genAI.getGenerativeModel({ model: this.config.model });
          const result = await model.generateContent(prompt);

          const response = await result.response;
          console.log(response.text());
          this.updateContent(response.text());

        } catch (error) {
          console.error("Error processing audio:", error);
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error processing audio: " + error.message });
        }
      }
    }

    this.node_helper.initializeGenAI(apiKey);
  },

  startRecording: function() {
    try {
      // Access the microphone
      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then((stream) => {
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const input = this.audioContext.createMediaStreamSource(stream);
          this.recorder = new Recorder(input, { numChannels: 1 }); // Mono audio
          this.recorder.record();

          console.log("Recording started...");
          this.updateContent("Recording...");
          // Send audio data to the live session every 500ms (adjust as needed)
          this.intervalId = setInterval(() => {
            this.recorder.exportWAV((blob) => {
              // Convert blob to ArrayBuffer for sending over the socket
              const fileReader = new FileReader();
              fileReader.onload = () => {
                const arrayBuffer = fileReader.result;
                try {
                  console.log("Sending audio chunk to live session");
                  // Convert ArrayBuffer to Uint8Array
                  const uint8Array = new Uint8Array(arrayBuffer);
                  //this.liveSession.send(uint8Array);
                  this.node_helper.sendMessage(uint8Array);

                } catch (error) {
                  console.error("Error sending audio to live session:", error);
                  this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error sending audio: " + error.message });
                  this.stopRecording();
                }
              };
              fileReader.readAsArrayBuffer(blob);

              this.recorder.clear(); // Clear the buffer after sending
            });
          }, 500); // Adjust interval for chunk size

        })
        .catch((err) => {
          console.error("Error accessing microphone:", err);
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error accessing microphone: " + err.message });
          this.stopRecording();
        });
    } catch (error) {
      console.error("Error starting recording:", error);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting recording: " + error.message });
      this.stopRecording();
    }
  },

  stopRecording: function() {
    if (this.recorder) {
      this.recorder.stop();
      console.log('Recording stopped.');
      this.updateContent("Recording stopped.");
      clearInterval(this.intervalId); // Clear the interval
      this.recorder = null;
      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
    }
  },

  notificationReceived: function(notification, payload) {
    if (notification === "DOM_OBJECTS_LOADED") {
      this.node_helper.startLiveChat();
    }
  },
});