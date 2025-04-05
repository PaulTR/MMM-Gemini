const NodeHelper = require("node_helper")
const { GoogleGenAI, Modality, DynamicRetrievalConfigMode, Type, PersonGeneration } = require("@google/genai")
const recorder = require('node-record-lpcm16')
const { Buffer } = require('buffer')
const util = require('util')

const Speaker = require('speaker')

// --- Configuration ---
const INPUT_SAMPLE_RATE = 44100 // Recorder captures at 44.1KHz for AT2020, otherwise 16000 for other microphones
const OUTPUT_SAMPLE_RATE = 24000 // Gemini outputs at 24kHz
const CHANNELS = 1
const AUDIO_TYPE = 'raw' // Gemini Live API uses raw data streams
const ENCODING = 'signed-integer'
const BITS = 16
const GEMINI_INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`
const CURRENT_MODALITY = Modality.AUDIO

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp' // Or 'gemini-1.5-pro-exp' etc.
const API_VERSION = 'v1alpha'

// --- Default Config ---
const DEFAULT_PLAYBACK_THRESHOLD = 6 // Start playing after receiving this many chunks

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    audioQueue: [],
    persistentSpeaker: null, // Use a speaker instance that persists while playing, rather than creating for every chunk
    processingQueue: false, // Indicates if the playback loop (_processQueue) is active
    apiInitialized: false,
    connectionOpen: false,
    apiInitializing: false,
    debug: false,
    config: { // Store config settings
        playbackThreshold: DEFAULT_PLAYBACK_THRESHOLD
    },

    // Logger functions
    log: function(...args) { console.log(`[${new Date().toISOString()}] LOG (${this.name}):`, ...args) },
    error: function(...args) { console.error(`[${new Date().toISOString()}] ERROR (${this.name}):`, ...args) },
    warn: function(...args) { console.warn(`[${new Date().toISOString()}] WARN (${this.name}):`, ...args) },
    sendToFrontend: function(notification, payload) { this.sendSocketNotification(notification, payload) },

    // --- Lifecycle Functions ---
    start: function() {
        this.log(`Starting node_helper...`)
        this.recordingProcess = null
        this.isRecording = false
        this.audioQueue = []
        this.persistentSpeaker = null // Initialize as null
        this.processingQueue = false
        this.apiInitialized = false
        this.connectionOpen = false
        this.apiInitializing = false
        this.liveSession = null
        this.genAI = null
        this.imaGenAI = null
        this.apiKey = null
        this.debug = false
        this.config = { playbackThreshold: DEFAULT_PLAYBACK_THRESHOLD } // Reset config
    },

    // Initialize Google GenAI and Live Connection
    async initialize(apiKey) {
        this.log(">>> initialize called")

        if (this.apiInitialized || this.apiInitializing) {
            this.warn(`API initialization already complete or in progress. Initialized: ${this.apiInitialized}, Initializing: ${this.apiInitializing}`)
            if (this.connectionOpen) {
                 this.log("Connection already open, sending HELPER_READY")
                 this.sendToFrontend("HELPER_READY")
            }
            return
        }
        if (!apiKey) {
            this.error(`API Key is missing! Cannot initialize`)
            this.sendToFrontend("HELPER_ERROR", { error: "API Key missing on server" })
            return
        }

        this.apiKey = apiKey
        this.apiInitializing = true
        this.log(`Initializing GoogleGenAI for ${API_VERSION}...`)

        try {
            this.log("Step 1: Creating GoogleGenAI instances...")

            this.genAI = new GoogleGenAI({
                apiKey: this.apiKey,
                httpOptions: { 'apiVersion': API_VERSION }
            })

            this.imaGenAI = new GoogleGenAI({
                apiKey: this.apiKey,
            })

            this.log(`Step 2: GoogleGenAI instance created. API Version: ${API_VERSION}`)
            this.log(`Step 3: Attempting to establish Live Connection with ${GEMINI_MODEL}...`)

            // --- State Reset before Connecting ---
            this.processingQueue = false // Ensure playback stops on reconnect
            this.audioQueue = []       // Clear any leftover audio
            this.closePersistentSpeaker() // Close any existing speaker cleanly
            // --- End State Reset ---

            this.liveSession = await this.genAI.live.connect({
                model: GEMINI_MODEL,
                callbacks: {
                    onopen: () => {
                        this.log(">>> Live Connection Callback: onopen triggered!")
                        this.connectionOpen = true
                        this.apiInitializing = false
                        this.apiInitialized = true
                        this.log("Connection OPENED. Sending HELPER_READY")
                        this.sendToFrontend("HELPER_READY")
                    },
                    onmessage: (message) => { this.handleGeminiResponse(message) },
                    onerror: (e) => {
                        this.error(`Live Connection ERROR: ${e?.message || e}`)
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        this.closePersistentSpeaker() // Close speaker on error
                        this.processingQueue = false
                        this.audioQueue = []
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${e?.message || e}` })
                    },
                    onclose: (e) => {
                        this.warn(`Live Connection CLOSED: ` + JSON.stringify())
                        const wasOpen = this.connectionOpen
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        this.closePersistentSpeaker() // Close speaker on close
                        this.processingQueue = false
                        this.audioQueue = []
                        if (wasOpen) {
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly` })
                            // Consider delay/retry logic before re-init
                        } else { this.log("Live Connection closed normally") }
                    },
                },
                // Define connection configuration
                config: {
                    responseModalities: [Modality.AUDIO],
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
            this.log(`Step 4: live.connect call initiated...`)
        } catch (error) {
            this.error(`API Initialization failed:`, error)
            this.liveSession = null
            this.apiInitialized = false
            this.connectionOpen = false
            this.apiInitializing = false
            this.closePersistentSpeaker() // Ensure speaker is closed on init failure
            this.processingQueue = false
            this.audioQueue = []
            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` })
        }
    },

    // Handle messages from the module frontend
    socketNotificationReceived: async function(notification, payload) {
        switch (notification) {
            case "START_CONNECTION":
                this.log(`>>> socketNotificationReceived: Handling START_CONNECTION`)
                if (!payload || !payload.apiKey) {
                     this.error(`START_CONNECTION received without API key`)
                     this.sendToFrontend("HELPER_ERROR", { error: "API key not provided by frontend" })
                     return
                 }
                this.debug = payload.debug || false
                // --- Update Config ---
                if (payload.config && typeof payload.config.playbackThreshold === 'number') {
                    this.config.playbackThreshold = payload.config.playbackThreshold
                    this.log(`Using playbackThreshold from frontend: ${this.config.playbackThreshold}`)
                } else {
                     this.config.playbackThreshold = DEFAULT_PLAYBACK_THRESHOLD
                     this.log(`Using default playbackThreshold: ${this.config.playbackThreshold}`)
                }
                // --- End Update Config ---
                try { await this.initialize(payload.apiKey) } catch (error) {
                     this.error(">>> socketNotificationReceived: Error occurred synchronously when CALLING initialize:", error)
                     this.sendToFrontend("HELPER_ERROR", { error: `Error initiating connection: ${error.message}` })
                 }
                break
            case "START_CONTINUOUS_RECORDING":
                this.log(`>>> socketNotificationReceived: Handling START_CONTINUOUS_RECORDING`)
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready/open. ConnOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`)
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready" })
                    if (!this.apiInitialized && !this.apiInitializing && this.apiKey) {
                         this.warn("Attempting to re-initialize API connection...")
                         await this.initialize(this.apiKey) // Await re-initialization
                    }
                    return
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring START_CONTINUOUS_RECORDING request`)
                    return
                }
                this.startRecording()
                break
             case "STOP_CONTINUOUS_RECORDING":
                 this.log(`>>> socketNotificationReceived: Handling STOP_CONTINUOUS_RECORDING`)
                 this.stopRecording() // Use the existing stopRecording function
                 break
        }
    },

    // Start continuous audio recording and streaming
    startRecording() {
        this.log(">>> startRecording called")

        if (this.isRecording) {
            this.warn("startRecording called but already recording")
            return
        }
        if (!this.connectionOpen || !this.liveSession) {
             this.error("Cannot start recording: Live session not open")
             this.sendToFrontend("HELPER_ERROR", { error: "Cannot start recording: API connection not open" })
             return
        }

        this.isRecording = true
        this.log(">>> startRecording: Sending RECORDING_STARTED to frontend")
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
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) {
                        this.warn(`Recording stopping mid-stream: Session/Connection invalid...`)
                        this.stopRecording(true) // Force stop if state is inconsistent
                    }
                    return
                }

                if (chunk.length === 0) {
                    return // Skip empty chunks
                }

                const base64Chunk = chunk.toString('base64')
                chunkCounter++ // Increment counter for valid chunks

                try {
                    const payloadToSend = { media: { mimeType: GEMINI_INPUT_MIME_TYPE, data: base64Chunk } }

                    // Check liveSession again just before sending
                    if (this.liveSession && this.connectionOpen) {
                        await this.liveSession.sendRealtimeInput(payloadToSend)
                    } else {
                        this.warn(`Cannot send chunk #${chunkCounter}, connection/session lost just before send`)
                        this.stopRecording(true) // Stop recording if connection lost
                    }
                } catch (apiError) {
                    const errorTime = new Date().toISOString()
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter}:`, apiError)

                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack)
                    }

                     // Check specific error types if possible, otherwise assume connection issue
                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000 || apiError.message?.includes('INVALID_STATE')) {
                         this.warn("API error suggests connection closed/closing or invalid state")
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
                 this.warn(`Recording stream ended`) // Normal if stopRecording was called, unexpected otherwise
                 if (this.isRecording) {
                      // This might happen if the underlying recording process exits for some reason
                      this.error("Recording stream ended while isRecording was still true (unexpected)")
                      this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly" })
                      this.stopRecording(true) // Ensure state is consistent
                 }
             })

            this.recordingProcess.process.on('exit', (code, signal) => {
                const wasRecording = this.isRecording // Capture state before potential modification
                this.log(`Recording process exited with code ${code}, signal ${signal}`) // Changed from warn to log

                const currentProcessRef = this.recordingProcess // Store ref before nullifying

                this.recordingProcess = null // Clear the reference immediately

                if (wasRecording) {
                    // If we *thought* we were recording when the process exited, it's an error/unexpected stop
                    this.error(`Recording process exited unexpectedly while isRecording was true`)
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` })
                    this.isRecording = false // Update state
                    this.sendToFrontend("RECORDING_STOPPED") // Notify frontend it stopped
                }
                else {
                    // If isRecording was already false, this exit is expected (due to stopRecording being called)
                    this.log(`Recording process exited normally after stop request`)
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
        }
    },

    // Stop audio recording
    stopRecording(force = false) {
        if (this.isRecording || force) {
            if (!this.recordingProcess) {
                this.log(`stopRecording called (Forced: ${force}) but no recording process instance exists`)
                 if (this.isRecording) {
                      this.warn("State discrepancy: isRecording was true but no process found. Resetting state")
                      this.isRecording = false
                      this.sendToFrontend("RECORDING_STOPPED") // Notify frontend about the state correction
                 }
                 return
            }

            this.log(`Stopping recording process (Forced: ${force})...`)
            const wasRecording = this.isRecording // Capture state before changing
            this.isRecording = false // Set flag immediately

            // Store process reference before potentially nullifying it in callbacks
            const processToStop = this.recordingProcess

            try {
                const stream = processToStop.stream()
                if (stream) {
                    this.log("Removing stream listeners")
                    stream.removeAllListeners('data')
                    stream.removeAllListeners('error')
                    stream.removeAllListeners('end')
                }

                 if (processToStop.process) {
                    this.log("Removing process 'exit' listener")
                    processToStop.process.removeAllListeners('exit')

                    this.log("Sending SIGTERM to recording process")
                    processToStop.process.kill('SIGTERM')

                    // Set a timeout to forcefully kill if SIGTERM doesn't work
                    const killTimeout = setTimeout(() => {
                        // Check if the process reference still exists and if it wasn't killed yet
                        if (processToStop && processToStop.process && !processToStop.process.killed) {
                            this.warn("Recording process did not exit after SIGTERM, sending SIGKILL")
                            processToStop.process.kill('SIGKILL')
                        }
                    }, 800) // Increased timeout slightly

                     // Add a one-time listener for exit *after* sending kill signals
                     // to clear the timeout if it exits gracefully
                     processToStop.process.once('exit', () => {
                         this.log("Recording process exited after kill signal (or naturally). Clearing kill timeout")
                         clearTimeout(killTimeout)
                         // this.recordingProcess = null is handled by the main exit handler now
                     })

                 } else {
                    this.warn("No underlying process found in recordingProcess object to kill")
                 }

                 // Call the library's stop method, which might also attempt cleanup
                 this.log(`Calling recorder.stop()...`)
                 processToStop.stop()

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError)
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack)
                }
            } finally {
                // Don't nullify this.recordingProcess here; let the 'exit' handler do it.
                if (wasRecording) {
                    this.log("Recording stop initiated. Sending RECORDING_STOPPED if process exits")
                    // Actual RECORDING_STOPPED is sent by the 'exit' handler or state correction logic
                } else {
                     this.log("Recording was already stopped or stopping, no state change needed")
                }
            }
        } else {
            this.log(`stopRecording called, but isRecording flag was already false`)
            // Defensive cleanup if process still exists somehow
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup")
                 this.stopRecording(true) // Force stop to clean up the zombie process
            }
        }
    },

    // Handle function calls requested by Gemini
    async handleFunctionCall(functioncall) {
        let functionName = functioncall.name
        let args = functioncall.args

        if(!functionName || !args) {
            this.warn("Received function call without name or arguments:", functioncall)
            return
        }

        this.log(`Handling function call: ${functionName}`)

        switch(functionName) {
            case "generate_image":
                let generateImagePrompt = args.image_prompt
                if (generateImagePrompt) {
                    this.log(`Generating image with prompt: "${generateImagePrompt}"`)
                    this.sendToFrontend("GEMINI_IMAGE_GENERATING")
                    try {
                        const response = await this.imaGenAI.models.generateImages({
                            model: 'imagen-3.0-generate-002', // Consider making model configurable
                            prompt: generateImagePrompt,
                            config: {
                                numberOfImages: 1,
                                includeRaiReason: true,
                                // personGeneration: PersonGeneration.ALLOW_ADULT, // Uncomment if needed
                            },
                        })

                        // Handle potential safety flags/RAI reasons
                        if (response?.generatedImages?.[0]?.raiReason) {
                             this.warn(`Image generation flagged for RAI reason: ${response.generatedImages[0].raiReason}`)
                             this.sendToFrontend("GEMINI_IMAGE_BLOCKED", { reason: response.generatedImages[0].raiReason })
                        } else {
                            let imageBytes = response?.generatedImages?.[0]?.image?.imageBytes
                            if (imageBytes) {
                                this.log("Image generated successfully")
                                this.sendToFrontend("GEMINI_IMAGE_GENERATED", { image: imageBytes })
                            } else {
                                this.error("Image generation response received, but no image bytes found")
                                this.sendToFrontend("HELPER_ERROR", { error: "Image generation failed: No image data" })
                            }
                        }
                    } catch (imageError) {
                         this.error("Error during image generation API call:", imageError)
                         this.sendToFrontend("HELPER_ERROR", { error: `Image generation failed: ${imageError.message}` })
                    }

                } else {
                     this.warn("generate_image call missing 'image_prompt' argument")
                }
                break
            // Add other function cases here if needed
            default:
                this.warn(`Received unhandled function call: ${functionName}`)
        }
    },

    // Handle responses received from Gemini Live Connection
    async handleGeminiResponse(message) {
        if (message?.setupComplete) { return } // Ignore setup message

        let content = message?.serverContent?.modelTurn?.parts?.[0]
        let functioncall = message?.toolCall?.functionCalls?.[0]

        // --- Handle Text ---
        if (content?.text) {
            this.log(`Extracted text: ` + content.text)
            this.sendToFrontend("GEMINI_TEXT_RESPONSE", { text: content.text })
        }

        // --- Extract and Queue Audio Data ---
        let extractedAudioData = content?.inlineData?.data
        if (extractedAudioData) {
            this.audioQueue.push(extractedAudioData)

            // --- Trigger Playback if Threshold Reached and Not Already Playing ---
            if (!this.processingQueue && this.audioQueue.length >= this.config.playbackThreshold) {
                this.log(`Audio queue reached threshold (${this.audioQueue.length} >= ${this.config.playbackThreshold}). Starting playback`)
                this._processQueue() // Start the playback loop
            }
        }

        // --- Handle Function Calls ---
        if (functioncall) {
            await this.handleFunctionCall(functioncall)
        }

        if( message?.serverContent?.interrupted && this.CURRENT_MODALITY == Modality.AUDIO) {
            this.log("Interrupted!!! " + JSON.stringify(message))
            this.audioQueue = [] // Clear any queued audio chunks from the interrupted response
            this.closePersistentSpeaker()
        }

        // --- Check for Turn Completion (LOGGING ONLY) ---
        if (message?.serverContent?.turnComplete) {
            this.log("Turn complete signal received")
            // Send turn complete notification (still useful for UI)
            this.sendToFrontend("GEMINI_TURN_COMPLETE", {})
        }

        // --- Handle Blocked Prompt/Safety ---
        if (message?.serverContent?.modelTurn?.blockedReason) {
             this.warn(`Gemini response blocked. Reason: ${message.serverContent.modelTurn.blockedReason}`)
             this.sendToFrontend("GEMINI_RESPONSE_BLOCKED", { reason: message.serverContent.modelTurn.blockedReason })
             // --- Clear Queue and Stop Playback on Block ---
             this.audioQueue = []
             if (this.processingQueue) {
                 this.log("Stopping playback due to blocked response")
                 this.closePersistentSpeaker() // Close speaker cleanly
             }
             // --- End Clear Queue ---
        }
    },

    // Process the audio queue for playback (low-latency approach)
    _processQueue() {
        // 1. Check Stop Condition (Queue Empty)
        if (this.audioQueue.length === 0) {
            this.log("_processQueue: Queue is empty. Playback loop ending")
            // Speaker should be closed by the last write callback's .end()
            // Safeguard: ensure flag is false and close speaker if it exists.
            this.processingQueue = false
            if (this.persistentSpeaker) {
                this.warn("_processQueue found empty queue but speaker exists! Forcing close")
                this.closePersistentSpeaker()
            }
            return // Stop the loop
        }

        // 2. Ensure Playback Flag is Set
        if (!this.processingQueue) {
             this.processingQueue = true
             this.log("_processQueue: Starting playback loop")
        }

        // 3. Ensure Speaker Exists (Create ONLY if needed)
        if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
            this.log("Creating new persistent speaker instance")
            try {
                this.persistentSpeaker = new Speaker({
                    channels: CHANNELS,
                    bitDepth: BITS,
                    sampleRate: OUTPUT_SAMPLE_RATE,
                })

                // --- Setup listeners ONCE per speaker instance ---
                this.persistentSpeaker.once('error', (err) => { // Use 'once' if we always recreate? No, use 'on' for persistent
                    this.error('Persistent Speaker Error:', err)
                    this.closePersistentSpeaker() // Use helper to close and reset state
                })

                this.persistentSpeaker.once('close', () => { // Use 'once' for cleanup handler
                    this.log('Persistent Speaker Closed Event')
                    // Ensure state is clean if closed unexpectedly or after end()
                    this.persistentSpeaker = null
                    if (this.processingQueue) {
                         this.log('Speaker closed. Resetting processing flag')
                         this.processingQueue = false
                    }
                    // Optional: Check if queue has items again and restart?
                    // if(this.audioQueue.length > 0 && !this.processingQueue) { this._processQueue() }
                })

                this.persistentSpeaker.once('open', () => this.log('Persistent Speaker opened'))

            } catch (e) {
                this.error('Failed to create persistent speaker:', e)
                this.persistentSpeaker = null // Ensure it's null
                this.processingQueue = false // Stop processing if speaker fails
                this.audioQueue = [] // Clear queue as we can't play
                return // Exit if speaker cannot be created
            }
        }

         // Check again after attempting creation
         if (!this.persistentSpeaker) {
             this.error("Cannot process queue, speaker instance is not available")
             this.processingQueue = false // Stop processing
             return
         }

        // 4. Get and Write ONE Chunk
        const chunkBase64 = this.audioQueue.shift() // Take the next chunk
        const buffer = Buffer.from(chunkBase64, 'base64')

        this.persistentSpeaker.write(buffer, (err) => {
            if (err) {
                this.error("Error writing buffer to persistent speaker:", err)
                // Speaker error listener should handle cleanup via closePersistentSpeaker()
                // Avoid calling closePersistentSpeaker directly here to prevent race conditions
                return // Stop the loop on error
            }

            // Write successful

            // 5. Decide Next Step (Continue Loop or End Stream)
            if (this.audioQueue.length > 0) {
                // More chunks waiting? Immediately schedule the next write
                this._processQueue()
            } else {
                // Queue is empty *after* taking the last chunk
                this.log("Audio queue empty after playing chunk. Ending speaker stream gracefully")
                 if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
                     // Call end() - allows last chunk to play, then 'close' event fires
                     this.persistentSpeaker.end(() => {
                        this.log("Speaker .end() callback fired after last chunk write")
                        // The 'close' listener handles the actual state cleanup
                     })
                 } else {
                     // Speaker already gone? Ensure flag is false
                     this.processingQueue = false
                 }
            }
        }) // End write callback
    },

    // Helper to Close Speaker Cleanly
    closePersistentSpeaker() {
        if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
            this.log("Closing persistent speaker...")
            try {
                 // Remove listeners to prevent acting on events after initiating close
                 this.persistentSpeaker.removeAllListeners() // Remove all listeners associated with this speaker

                 // Call end to flush and close gracefully
                 // The 'close' event should ideally handle state reset, but do it defensively here too
                 this.persistentSpeaker.end(() => {
                     this.log("Speaker .end() callback fired during closePersistentSpeaker")
                 })
                 this.persistentSpeaker = null
                 this.processingQueue = false // Reset state immediately after initiating close
                 this.log("Speaker close initiated, state reset")

            } catch (e) {
                this.error("Error trying to close persistent speaker:", e)
                this.persistentSpeaker = null // Ensure null even if close fails
                this.processingQueue = false // Reset state
            }
        } else {
            // If speaker doesn't exist or already destroyed, ensure state is correct
            this.persistentSpeaker = null
            this.processingQueue = false // Reset flag just in case
        }
    } // --- End closePersistentSpeaker ---

}) // End NodeHelper.create