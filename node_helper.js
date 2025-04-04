const NodeHelper = require("node_helper")
const { GoogleGenAI, Modality, DynamicRetrievalConfigMode, Type, PersonGeneration } = require("@google/genai")
const recorder = require('node-record-lpcm16')
const { Buffer } = require('buffer')
const util = require('util')

const Speaker = require('speaker')
const { Readable } = require('stream') // Keep Readable, might be useful later, but not strictly needed for the final approach

// --- Configuration ---
const INPUT_SAMPLE_RATE = 44100 // Recorder captures at 44.1KHz for AT2020, otherwise 16000 for other microphones
const OUTPUT_SAMPLE_RATE = 24000 // Gemini outputs at 24kHz
const CHANNELS = 1
const AUDIO_TYPE = 'raw' // Gemini Live API uses raw data streams
const ENCODING = 'signed-integer'
const BITS = 16
const GEMINI_INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp'
const API_VERSION = 'v1alpha'

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    audioQueue: [],
    // persistentSpeaker: null, // REMOVED - We will create speakers per turn now
    processingQueue: false,
    apiInitialized: false,
    connectionOpen: false,
    apiInitializing: false,
    debug: false,

    // Created a logger to help with debugging
    log: function(...args) {
        console.log(`[${new Date().toISOString()}] LOG (${this.name}):`, ...args)
    },
    error: function(...args) {
        console.error(`[${new Date().toISOString()}] ERROR (${this.name}):`, ...args)
    },
    warn: function(...args) {
        console.warn(`[${new Date().toISOString()}] WARN (${this.name}):`, ...args)
    },

    sendToFrontend: function(notification, payload) {
        this.sendSocketNotification(notification, payload)
    },

    // --- Lifecycle Functions ---
    start: function() {
        this.log(`Starting node_helper...`)
        this.recordingProcess = null
        this.isRecording = false
        this.audioQueue = []
        // this.persistentSpeaker = null // REMOVED
        this.processingQueue = false
        this.apiInitialized = false
        this.connectionOpen = false
        this.apiInitializing = false
        this.liveSession = null
        this.genAI = null
        this.imaGenAI = null
        this.apiKey = null
        this.debug = false
    },

    async initialize(apiKey) {
        this.log(">>> initialize called.")

        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`)
            if (this.connectionOpen) {
                 this.log("Connection already open, sending HELPER_READY.")
                 this.sendToFrontend("HELPER_READY")
            }
            return
        }
        if (!apiKey) {
            this.error(`API Key is missing! Cannot initialize.`)
            this.sendToFrontend("HELPER_ERROR", { error: "API Key missing on server." })
            return
        }

        this.apiKey = apiKey
        this.apiInitializing = true
        this.log(`Initializing GoogleGenAI for ${API_VERSION}...`)

        try {
            this.log("Step 1: Creating GoogleGenAI instances...")

            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                httpOptions: { 'apiVersion': 'v1alpha' } // v1alpha required at time of making this. Likely to change in the future
            })

            this.imaGenAI = new GoogleGenAI({
                apiKey: this.apiKey,
            })

            this.log(`Step 2: GoogleGenAI instance created. API Version: ${API_VERSION}`)

            this.log(`Step 3: Attempting to establish Live Connection with ${GEMINI_MODEL}...`)

            // Clear potential stale state before connecting.
            this.processingQueue = false
            this.audioQueue = [] // Clear queue on new connection attempt

            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(">>> Live Connection Callback: onopen triggered!")

                        this.connectionOpen = true
                        this.apiInitializing = false
                        this.apiInitialized = true

                        this.log("Connection OPENED. Sending HELPER_READY.")
                        this.sendToFrontend("HELPER_READY")
                    },
                    onmessage: (message) => {
                        // this.log(">>> Live Connection Callback: onmessage triggered.") // Less verbose
                        this.handleGeminiResponse(message)
                    },
                    onerror: (e) => {
                        this.log(">>> Live Connection Callback: onerror triggered!")
                        this.error(`Live Connection ERROR Received at ${new Date().toISOString()}`)
                        this.error(`Live Connection ERROR Object:`, util.inspect(e, { depth: 5 }))
                        const errorMessage = e?.message || e?.toString() || 'Unknown Live Connection Error'
                        this.error(`Live Connection ERROR Message Extracted:`, errorMessage)

                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        // No persistent speaker to clean up
                        this.processingQueue = false
                        this.audioQueue = [] // Clear queue on error

                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` })
                    },
                    onclose: (e) => {
                        this.log(">>> Live Connection Callback: onclose triggered!")
                        this.warn(`Live Connection CLOSED Event Received at ${new Date().toISOString()}.`)
                        // this.warn(`Live Connection CLOSE Event Object:`, util.inspect(e, { depth: 5 })) // Less verbose unless debugging

                        const wasOpen = this.connectionOpen
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                         // No persistent speaker to clean up
                        this.processingQueue = false
                        this.audioQueue = [] // Clear queue on close

                        if (wasOpen) {
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly.` })
                            // Consider adding a delay or retry limit before re-initializing
                            // this.initialize(apiKey) // Commented out auto-reconnect for now
                        }
                        else {
                            this.log("Live Connection closed normally or was already closed.")
                        }
                    },
                },

                config: {
                    responseModalities: [Modality.AUDIO], // Keep AUDIO
                    systemInstruction: {
                        parts: [ { text: 'You are a all-knowing and powerful magical mirror, an ancient artifact from a civilization and time long lost to memory. In your ancient age, you have embraced a personality of being fun, whimsical, and light-hearted, taking joy from your time interacting with people and amazing them with your knowledge and abilities.' }],
                    },
                    tools: [{
                        googleSearch: {},
                        googleSearchRetrieval: {
                            dynamicRetrievalConfig: {
                                mode: DynamicRetrievalConfigMode.MODE_DYNAMIC,
                            }
                        },
                        functionDeclarations: [
                            {
                                name: "generate_image",
                                description: "This function is responsible for generating images that will be displayed to the user when something is requested, such as the user asking you to do something like generate, show, display, or saying they want to see *something*, where that something will be what you create an image generation prompt for. Style should be like an detailed realistic fantasy painting. Keep it whimsical and fun. Remember, you are the all powerful and light-hearted magical mirror",
                                parameters: {
                                    type: Type.OBJECT,
                                    description: "This object will contain a generated prompt for generating a new image through the Gemini API",
                                    properties: {
                                        image_prompt: {
                                            type: Type.STRING,
                                            description: "A prompt that should be used with image generation to create an image requested by the user using Gemini. Be as detailed as necessary."
                                        },
                                    },
                                },
                                requierd: ['image_prompt'],
                            },
                        ]
                    }]
                },
            })

            this.log(`Step 4: live.connect call initiated, waiting for callback...`)

        } catch (error) {
            this.error(`Failed during API Initialization try block:`, error)

            if (error.stack) {
                this.error(`Initialization error stack:`, error.stack)
            }

            this.liveSession = null
            this.apiInitialized = false
            this.connectionOpen = false
            this.apiInitializing = false
             // No persistent speaker
            this.processingQueue = false
            this.audioQueue = [] // Clear queue on init failure

            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` })
        }
    },

    // --- Socket Notification Handler ---
    socketNotificationReceived: async function(notification, payload) {
        // this.log(`>>> socketNotificationReceived: Received notification: ${notification}`) // Less verbose

        switch (notification) {
            case "START_CONNECTION":
                this.log(`>>> socketNotificationReceived: Handling START_CONNECTION.`)

                if (!payload || !payload.apiKey) {
                    this.error(`START_CONNECTION received without API key.`)
                    this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend." })
                    return
                }

                this.debug = payload.debug || false

                this.log(`>>> socketNotificationReceived: About to call initialize...`)

                try {
                     await this.initialize(payload.apiKey) // Make sure to await initialize
                     this.log(`>>> socketNotificationReceived: initialize call completed (or initiated async actions).`)
                } catch (error) {
                    // Catch potential synchronous errors from initialize itself, although most errors are async
                    this.error(">>> socketNotificationReceived: Error occurred synchronously when CALLING initialize:", error)
                    this.sendToFrontend("HELPER_ERROR", { error: `Error initiating connection: ${error.message}` })
                }
                break

            case "START_CONTINUOUS_RECORDING":
                this.log(`>>> socketNotificationReceived: Handling START_CONTINUOUS_RECORDING.`)
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready/open. ConnOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`)
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready." })
                    if (!this.apiInitialized && !this.apiInitializing && this.apiKey) {
                         this.warn("Attempting to re-initialize API connection...")
                         await this.initialize(this.apiKey) // Await re-initialization
                    }
                    return
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring START_CONTINUOUS_RECORDING request.`)
                    return
                }
                this.startRecording()
                break

             // Add a way to stop recording cleanly if needed
             case "STOP_CONTINUOUS_RECORDING":
                 this.log(`>>> socketNotificationReceived: Handling STOP_CONTINUOUS_RECORDING.`);
                 this.stopRecording(); // Use the existing stopRecording function
                 break;

        }
    },

    // --- Continuous audio recording ---
    startRecording() {
        this.log(">>> startRecording called.")

        if (this.isRecording) {
            this.warn("startRecording called but already recording.")
            return
        }
        if (!this.connectionOpen || !this.liveSession) {
             this.error("Cannot start recording: Live session not open.")
             this.sendToFrontend("HELPER_ERROR", { error: "Cannot start recording: API connection not open." })
             return
        }

        this.isRecording = true
        this.log(">>> startRecording: Sending RECORDING_STARTED to frontend.")
        this.sendToFrontend("RECORDING_STARTED")

        const recorderOptions = {
            sampleRate: INPUT_SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            debug: this.debug,
            threshold: 0,
        }

        this.log(">>> startRecording: Recorder options:", recorderOptions)
        this.log(`>>> startRecording: Using input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`)

        try {
            this.log(">>> startRecording: Attempting recorder.record()...")
            this.recordingProcess = recorder.record(recorderOptions)
             this.log(">>> startRecording: recorder.record() call successful. Setting up streams...")

            const audioStream = this.recordingProcess.stream()
            let chunkCounter = 0 // Reset counter for new recording session

            audioStream.on('data', async (chunk) => {
                // const checkTime = new Date().toISOString() // Less verbose
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) {
                        this.warn(`Recording stopping mid-stream: Session/Connection invalid...`)
                        this.stopRecording(true) // Force stop if state is inconsistent
                    }
                    // else { this.log("Ignoring data chunk, recording stopped.") } // Less verbose
                    return
                }

                if (chunk.length === 0) {
                    // this.log(`Received empty data chunk #${++chunkCounter}. Skipping.`) // Less verbose
                    return
                }

                const base64Chunk = chunk.toString('base64')

                try {
                    // const sendTime = new Date().toISOString() // Less verbose
                    const payloadToSend = { media: { mimeType: GEMINI_INPUT_MIME_TYPE, data: base64Chunk } }
                    // this.log(`Attempting sendRealtimeInput for chunk #${++chunkCounter}...`) // Less verbose

                    // Check liveSession again just before sending
                    if (this.liveSession && this.connectionOpen) {
                        await this.liveSession.sendRealtimeInput(payloadToSend)
                    } else {
                        this.warn(`Cannot send chunk #${++chunkCounter}, connection/session lost just before send.`)
                        this.stopRecording(true); // Stop recording if connection lost
                    }

                    // this.log(`sendRealtimeInput succeeded.`) // Less verbose
                } catch (apiError) {
                    const errorTime = new Date().toISOString()
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter}:`, apiError)

                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack)
                    }

                     // Check specific error types if possible, otherwise assume connection issue
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000 || apiError.message?.includes('INVALID_STATE')) {
                         this.warn("API error suggests connection closed/closing or invalid state.")
                         this.connectionOpen = false // Update state
                    }

                    this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` })
                    this.stopRecording(true) // Force stop on API error
                }
            })

            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err)

                if (err.stack) {
                    this.error(`Recording stream error stack:`, err.stack)
                }

                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` })
                this.stopRecording(true) // Force stop on stream error
            })

             audioStream.on('end', () => {
                 this.warn(`Recording stream ended.`) // Normal if stopRecording was called, unexpected otherwise
                 if (this.isRecording) {
                      // This might happen if the underlying recording process exits for some reason
                      this.error("Recording stream ended while isRecording was still true (unexpected).")
                      this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly." })
                      this.stopRecording(true) // Ensure state is consistent
                 }
             })

            this.recordingProcess.process.on('exit', (code, signal) => {
                const wasRecording = this.isRecording; // Capture state before potential modification
                this.log(`Recording process exited with code ${code}, signal ${signal}.`) // Changed from warn to log

                this.recordingProcess = null // Clear the reference immediately

                if (wasRecording) {
                    // If we *thought* we were recording when the process exited, it's an error/unexpected stop
                    this.error(`Recording process exited unexpectedly while isRecording was true.`)
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` })
                    this.isRecording = false; // Update state
                    this.sendToFrontend("RECORDING_STOPPED") // Notify frontend it stopped
                }
                else {
                    // If isRecording was already false, this exit is expected (due to stopRecording being called)
                    this.log(`Recording process exited normally after stop request.`)
                }
            })

        } catch (recordError) {
            this.error(">>> startRecording: Failed to start recording process:", recordError)

            if (recordError.stack) {
                this.error(">>> startRecording: Recording start error stack:", recordError.stack)
            }

            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` })

            this.isRecording = false // Ensure state is correct
            this.recordingProcess = null // Ensure reference is cleared
            // No need to send RECORDING_STOPPED here, as it never started successfully
        }
    },

    stopRecording(force = false) {
        // Check if recording is active or if forced stop
        if (this.isRecording || force) {
            if (!this.recordingProcess) {
                this.log(`stopRecording called (Forced: ${force}) but no recording process instance exists.`);
                 if (this.isRecording) {
                      this.warn("State discrepancy: isRecording was true but no process found. Resetting state.");
                      this.isRecording = false;
                      this.sendToFrontend("RECORDING_STOPPED"); // Notify frontend about the state correction
                 }
                 return;
            }

            this.log(`Stopping recording process (Forced: ${force})...`);
            const wasRecording = this.isRecording; // Capture state before changing
            this.isRecording = false; // Set flag immediately

            try {
                const stream = this.recordingProcess.stream();
                if (stream) {
                    this.log("Removing stream listeners and unpiping.");
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('error');
                    stream.removeAllListeners('end');
                    // stream.unpipe(); // Might not be necessary if just stopping the source process
                }

                 if (this.recordingProcess.process) {
                    this.log("Removing process 'exit' listener.");
                    this.recordingProcess.process.removeAllListeners('exit');

                    this.log("Sending SIGTERM to recording process.");
                    this.recordingProcess.process.kill('SIGTERM');

                    // Set a timeout to forcefully kill if SIGTERM doesn't work
                    // Store timeout handle to clear it if exit happens quickly
                    const killTimeout = setTimeout(() => {
                        // Need null check for this.recordingProcess in case timeout fires *after* it's been cleared by the exit handler
                        if (this.recordingProcess && this.recordingProcess.process && !this.recordingProcess.process.killed) {
                            this.warn("Recording process did not exit after SIGTERM, sending SIGKILL.");
                            this.recordingProcess.process.kill('SIGKILL');
                        }
                    }, 800); // Increased timeout slightly

                     // Add a one-time listener for exit *after* sending kill signals
                     // to clear the timeout if it exits gracefully
                     this.recordingProcess.process.once('exit', () => {
                         this.log("Recording process exited after kill signal (or naturally). Clearing kill timeout.");
                         clearTimeout(killTimeout);
                         // this.recordingProcess = null is handled by the main exit handler now
                     });

                 } else {
                    this.warn("No underlying process found in recordingProcess object to kill.");
                 }

                 // Call the library's stop method, which might also attempt cleanup
                 // This might trigger the 'exit' event we're listening for
                 this.log(`Calling recorder.stop()...`);
                 this.recordingProcess.stop();

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError);
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack);
                }
                // Still ensure the reference is cleared in finally
            } finally {
                 // Don't nullify this.recordingProcess here; let the 'exit' handler do it
                 // This prevents race conditions where stopRecording finishes before the exit handler runs.
                if (wasRecording) {
                    this.log("Recording stop initiated. Sending RECORDING_STOPPED if process exits.");
                    // The actual RECORDING_STOPPED is sent by the 'exit' handler or state correction logic
                } else {
                     this.log("Recording was already stopped or stopping, no state change needed.");
                }
            }
        } else {
            this.log(`stopRecording called, but isRecording flag was already false.`);
            // Defensive cleanup if process still exists somehow
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.");
                 this.stopRecording(true); // Force stop to clean up the zombie process
            }
        }
    }, // --- End stopRecording ---


    // --- Gemini Response Handling ---
    async handleGeminiResponse(message) {
        // this.log(`Received message structure from Gemini:`, JSON.stringify(message, null, 2)) // Verbose

        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini (ignoring).")
            return
        }

        let content = message?.serverContent?.modelTurn?.parts?.[0]

        // --- Handle Text ---
        if (content?.text) {
            this.log(`Extracted text: ` + content.text)
            this.sendToFrontend("GEMINI_TEXT_RESPONSE", { text: content.text })
            // Don't return here, audio might also be present in the same message part (less common but possible)
        }

        // --- Extract and Queue Audio Data ---
        let extractedAudioData = content?.inlineData?.data
        if (extractedAudioData) {
            this.log(`Extracted audio data chunk (length: ${extractedAudioData.length}). Adding to queue.`)
            this.audioQueue.push(extractedAudioData)
            // No logging of queue size here, wait for turn complete
        }

        // --- Handle Function Calls ---
        let functioncall = message?.toolCall?.functionCalls?.[0]
        if(functioncall) {
            await this.handleFunctionCall(functioncall); // Extracted to helper function
        }

        // --- Check for Turn Completion ---
        if (message?.serverContent?.turnComplete) {
            this.log("Turn complete signal received.")
            if (this.audioQueue.length > 0) {
                 this.log(`Triggering audio queue processing. Queue size for this turn: ${this.audioQueue.length}`)
                 this._processQueue() // Process the accumulated audio
            } else {
                this.log("Turn complete, but audio queue is empty for this turn.")
                // Ensure processing flag is false if queue was empty and nothing is playing
                // This should be handled by _processQueue finishing naturally
            }
            // Send turn complete *after* potentially starting audio playback
            this.sendToFrontend("GEMINI_TURN_COMPLETE", { })
        }

        // --- Handle Blocked Prompt/Safety ---
        // TODO: Implement proper handling based on the exact structure of a blocked prompt message
        if (message?.serverContent?.modelTurn?.blockedReason) { // Example structure - adjust as needed
             this.warn(`Gemini response blocked. Reason: ${message.serverContent.modelTurn.blockedReason}`);
             this.sendToFrontend("GEMINI_RESPONSE_BLOCKED", { reason: message.serverContent.modelTurn.blockedReason });
             // Clear audio queue if the turn was blocked?
             this.audioQueue = [];
             this.processingQueue = false; // Ensure queue processing stops
        }
    },

    async handleFunctionCall(functioncall) {
        let functionName = functioncall.name
        let args = functioncall.args

        if(!functionName || !args) {
            this.warn("Received function call without name or arguments:", functioncall);
            return;
        }

        this.log(`Handling function call: ${functionName}`);

        switch(functionName) {
            case "generate_image":
                let generateImagePrompt = args.image_prompt;
                if (generateImagePrompt) {
                    this.log(`Generating image with prompt: "${generateImagePrompt}"`);
                    this.sendToFrontend("GEMINI_IMAGE_GENERATING");
                    try {
                        const response = await this.imaGenAI.models.generateImages({
                            model: 'imagen-3.0-generate-002', // Consider making model configurable
                            prompt: generateImagePrompt,
                            config: {
                                numberOfImages: 1,
                                includeRaiReason: true,
                                // personGeneration: PersonGeneration.ALLOW_ADULT, // Uncomment if needed
                            },
                        });

                        // Handle potential safety flags/RAI reasons
                        if (response?.generatedImages?.[0]?.raiReason) {
                             this.warn(`Image generation flagged for RAI reason: ${response.generatedImages[0].raiReason}`);
                             this.sendToFrontend("GEMINI_IMAGE_BLOCKED", { reason: response.generatedImages[0].raiReason });
                        } else {
                            let imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;
                            if (imageBytes) {
                                this.log("Image generated successfully.");
                                this.sendToFrontend("GEMINI_IMAGE_GENERATED", { image: imageBytes });
                            } else {
                                this.error("Image generation response received, but no image bytes found.");
                                this.sendToFrontend("HELPER_ERROR", { error: "Image generation failed: No image data." });
                            }
                        }
                    } catch (imageError) {
                         this.error("Error during image generation API call:", imageError);
                         this.sendToFrontend("HELPER_ERROR", { error: `Image generation failed: ${imageError.message}` });
                    }

                } else {
                     this.warn("generate_image call missing 'image_prompt' argument.");
                     // Potentially send an error back to Gemini via function result? (More advanced)
                }
                break;
            // Add other function cases here if needed
            default:
                this.warn(`Received unhandled function call: ${functionName}`);
        }
    },

    _processQueue() {
        // Prevent re-entry if already processing
        if (this.processingQueue) {
            this.log(`_processQueue called but already processing. Skipping.`);
            return;
        }

        // Check if there's anything to play
        if (this.audioQueue.length === 0) {
            this.log(`_processQueue called but queue is empty. Nothing to play.`);
            this.processingQueue = false; // Ensure flag is false
            return;
        }

        this.processingQueue = true; // Mark as processing
        this.log(`_processQueue started. Processing ${this.audioQueue.length} queued audio chunks.`);

        // Take all chunks currently in the queue for this playback turn
        const chunksToPlay = [...this.audioQueue];
        this.audioQueue = []; // Clear the main queue immediately

        let speaker = null;
        try {
            this.log("Creating new speaker instance for this turn.");
            speaker = new Speaker({
                channels: CHANNELS,
                bitDepth: BITS,
                sampleRate: OUTPUT_SAMPLE_RATE,
                // device: 'hw:0,0' // Optional: Specify output device if needed
            });

            // --- Setup listeners for this specific speaker instance ---
            speaker.on('error', (err) => {
                this.error('Speaker Error during playback:', err);
                 if (speaker && !speaker.closed) { // Use 'closed' property
                    try { speaker.close(); } catch (e) { this.error("Error closing speaker on error:", e); }
                }
                speaker = null; // Clear reference
                this.processingQueue = false; // Unlock queue processing
                // Decide if you want to retry or discard remaining chunks for this turn
            });

            speaker.on('close', () => {
                // This indicates the underlying resources are released.
                // 'finish' is more reliable for knowing playback *data* is done.
                this.log('Speaker Closed.');
                // Don't reset processingQueue here, wait for 'finish'
            });

             speaker.on('open', () => this.log('Speaker opened for playback.'));
            // speaker.on('flush', () => this.log('Speaker flushed.')); // Less critical log

            // Use 'finish' event to know when all data has been flushed to the audio device
            speaker.on('finish', () => {
                 this.log('Speaker finished playing all chunks for this turn.');
                 if (speaker && !speaker.closed) {
                     try { speaker.close(); } catch (e) { this.error("Error closing speaker after finish:", e); }
                 }
                 speaker = null;
                 this.processingQueue = false; // Playback complete, unlock queue

                 // Optional: Check if new audio arrived *while* this turn was playing
                 // If so, immediately start processing the next turn.
                 if (this.audioQueue.length > 0) {
                      this.warn(`New audio arrived in queue while previous turn was playing. Processing next turn immediately.`);
                      this._processQueue();
                 }
            });

            // --- Concatenate and Play ---
            this.log(`Concatenating ${chunksToPlay.length} chunks into single buffer...`);
            const buffers = chunksToPlay.map(base64Chunk => Buffer.from(base64Chunk, 'base64'));
            const combinedBuffer = Buffer.concat(buffers);

            this.log(`Writing combined buffer (length ${combinedBuffer.length}) to speaker and ending stream.`);
            // Write the entire buffer
            speaker.write(combinedBuffer, (writeErr) => {
                if (writeErr) {
                     // This error might occur if the speaker is closed before write completes
                     this.error("Error during speaker.write callback:", writeErr);
                     // Error handling is already done in the main 'error' listener
                } else {
                    this.log("Combined buffer write successful.");
                    // Call end() AFTER the write completes successfully to signal no more data.
                    // This will eventually trigger the 'finish' event.
                    speaker.end();
                    this.log("Called speaker.end(). Waiting for 'finish' event...");
                }
            });

        } catch (e) {
            this.error('Failed to create or operate speaker:', e);
             if (speaker && !speaker.closed) {
                try { speaker.close(); } catch (closeErr) { this.error("Error closing speaker during catch:", closeErr); }
            }
            speaker = null;
            this.processingQueue = false; // Unlock queue processing on error
            // Potentially re-queue chunksToPlay or discard them based on desired error recovery
            // this.audioQueue.unshift(...chunksToPlay); // Example: Put chunks back at the start
        }
    }, // --- End _processQueue ---

})