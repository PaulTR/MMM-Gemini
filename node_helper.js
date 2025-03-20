const NodeHelper = require("node_helper");
const { GoogleGenAI, Modality } = require("@google/genai");

module.exports = NodeHelper.create({

  genAI: null,
  liveSession: null,
  apiKey: null, // Store the API key

  initializeGenAI: function(apiKey) {
    if (!this.genAI) {
      console.log("initializing GenAI!");
      this.genAI = new GoogleGenAI({ apiKey: apiKey, httpOptions: {'apiVersion': 'v1alpha'} });
    }
  },

  async socketNotificationReceived(notification, payload) {
    if (notification === "MODULE_READY") {
      this.apiKey = payload.apiKey;
      this.initializeGenAI(this.apiKey);
    }

    if (notification === "START_CHAT") {
      this.startLiveChat();
    }

    if (notification === "STOP_CHAT") {
      this.stopLiveChat();
    }

    if (notification === "SEND_AUDIO") {
      const audioData = payload.audio;
      try {
        console.log("Sending audio chunk to live session");
        this.liveSession.send(audioData);

      } catch (error) {
        console.error("Error sending audio to live session:", error);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error sending audio: " + error.message });
        this.stopLiveChat();
      }
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
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Connected to Gemini Live API"});
            this.sendRecordingCode(); // Send the recording code to the client
          },
          onmessage: (event) => {
            console.log('Received message from the server: %s\n', event.data);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Gemini: " + event.data }); // Send response to module
          },
          onerror: (event) => {
            console.error('Error occurred: %s\n', event.error);
            this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error from Gemini: " + event.error });
            this.stopLiveChat();
          },
          onclose: () => {
            console.log('Connection to Gemini Live API closed.');
            this.sendSocketNotification("STOP_RECORDING");
          },
        },
      });

    } catch (error) {
      console.error("Error starting live chat:", error);
      this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error starting live chat: " + error.message });
    }
  },

  // Function to construct and send the client-side recording code
  sendRecordingCode: function() {
    const recordingCode = `
      (function() {
        let audioContext = null;
        let recorder = null;
        let intervalId = null;

        function startRecording() {
          try {
            navigator.mediaDevices.getUserMedia({ audio: true, video: false })
              .then((stream) => {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const input = audioContext.createMediaStreamSource(stream);
                recorder = new Recorder(input, { numChannels: 1 });
                recorder.record();

                console.log("Recording started...");
                // Send audio data to the live session every 500ms
                intervalId = setInterval(() => {
                  recorder.exportWAV((blob) => {
                    const fileReader = new FileReader();
                    fileReader.onload = () => {
                      const arrayBuffer = fileReader.result;
                      try {
                        const uint8Array = new Uint8Array(arrayBuffer);
                        // Send audio data back to the server
                        sendAudio(uint8Array);
                      } catch (error) {
                        console.error("Error sending audio:", error);
                        stopRecording();
                      }
                    };
                    fileReader.readAsArrayBuffer(blob);
                    recorder.clear();
                  });
                }, 500);
              })
              .catch((err) => {
                console.error("Error accessing microphone:", err);
              });
          } catch (error) {
            console.error("Error starting recording:", error);
          }
        }

        function stopRecording() {
          if (recorder) {
            recorder.stop();
            clearInterval(intervalId);
            recorder = null;
            if (audioContext) {
              audioContext.close();
              audioContext = null;
            }
          }
        }

        function sendAudio(audioData) {
          // Send audio data to the MagicMirror module
          MM.getModules().withClass("your-module-name").enumerate(function(module) {
            module.sendSocketNotification("SEND_AUDIO", { audio: audioData });
          });
        }

        // Expose startRecording and stopRecording to the outside
        window.startRecording = startRecording;
        window.stopRecording = stopRecording;

      })(); // Immediately invoked function expression (IIFE)
    `;

    this.sendSocketNotification("EXECUTE_CODE", { code: recordingCode });
  },

  async stopLiveChat() {
    //this.sendSocketNotification("STOP_RECORDING");

    if (this.liveSession) {
      try {
        await this.liveSession.close();
        console.log("Live session closed.");
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Live session closed."});
      } catch (error) {
        console.error("Error closing live session:", error);
        this.sendSocketNotification("NOTIFICATION_GENERATE_TEXT", { text: "Error closing live session: " + error.message});
      }
      this.liveSession = null;
    }
  },
});