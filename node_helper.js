const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");
const recorder = require('node-record-lpcm16'); // Use lowercase 'recorder'

module.exports = NodeHelper.create({

  genAI: null,
  // recorder: null,  // No longer need this here, it's handled locally
  liveSession: null,

  initializeGenAI: function(apiKey) {
    if (!this.genAI) {
      console.log("initializing!")
      this.genAI = new GoogleGenAI({ apiKey: apiKey, httpOptions: { 'apiVersion': 'v1alpha' } });
    }
  },

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
      this.initializeGenAI(apiKey);

      const response = await this.genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "Write a joke about a magic backpack. Keep it under 40 words",
      });

      console.log(response.text);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: response.text });
    }

    if (notification === "START_CHAT") {
      this.initializeGenAI(payload.apikey);

      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Starting chat" });

      this.startLiveChat();
    }

    if (notification === "STOP_CHAT") {
      this.stopLiveChat();
    }
  },

  async startLiveChat() {
    try {
      this.liveSession = await this.genAI.live.connect({
        model: 'gemini-2.0-flash-exp',
        config: {
          responseModalities: [Modality.TEXT],
        },
        callbacks: {
          onopen: () => {
            console.log('Connected to the Gemini Live API socket.');
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Connected to Gemini Live API" });
            this.startRecording();
          },
          onmessage: (event) => {
            console.log('Received message from the server: %s\n', event);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Gemini: " + event }); // Send response to module
          },
          onerror: (event) => {
            console.error('Error occurred: %s\n', event.error);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error from Gemini: " + event.error });
            this.stopLiveChat(); // Stop on error
          },
          onclose: () => {
            console.log('Connection to Gemini Live API closed.');
            // this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Disconnected from Gemini Live API"});
            // this.stopRecording(); // Stop recording when the connection closes -  Not needed, handled in stopLiveChat
          },
        },
      });

    } catch (error) {
      console.error("Error starting live chat:", error);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting live chat: " + error.message });
    }
  },


  startRecording() {
    const recordOptions = {
      sampleRateHertz: 16000, // Correct option name
      channels: 1,
      threshold: 0.5,
      recordProgram: 'rec', // or 'sox', depending on what's installed
      silence: '1.0', // Add a silence threshold (optional but good practice)
    };

    try {
      this.recording = recorder.record(recordOptions); // Use .record(), not .start()

      this.recording.stream() // Get the audio stream
        .on('data', (chunk) => {
          // Send audio chunk to Gemini
          if (this.liveSession) { // Important check: only send if connected
            try {
              console.log("Sending audio chunk to live session");
              this.liveSession.sendRealtimeInput({media: {data: chunk, mimeType: 'audio/pcm;rate=16000'}});
            } catch (sendError) {
              console.error("Error sending audio to live session:", sendError);
              this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error sending audio: " + sendError.message });
              this.stopLiveChat();
            }
          }
        })
        .on('error', (err) => {
          console.error('Recording error:', err);
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording error: " + err.message });
          this.stopLiveChat(); // Stop on recording error
        })
        .on('start', () => {
          console.log('Recording started...');
          this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording..." });
        })
        .on('end', () => {  // Listen for the 'end' event
            console.log('Recording ended');
        });


    } catch (error) {
      console.error("Error starting recording:", error);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting recording: " + error.message });
      this.stopLiveChat(); // Stop if recording setup fails
    }
  },



  stopRecording() {
    if (this.recording) {
      this.recording.stop();  // Correctly stop the recording
      console.log('Recording stopped.');
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Recording stopped." });
      this.recording = null; // Clear the reference
    }
  },



  async stopLiveChat() {
    this.stopRecording();  // Stop recording *before* closing the session

    if (this.liveSession) {
      try {
        await this.liveSession.close();
        console.log("Live session closed.");
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Live session closed." });
      } catch (error) {
        console.error("Error closing live session:", error);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error closing live session: " + error.message });
      }
      this.liveSession = null;
    }
  },
});