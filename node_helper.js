const NodeHelper = require("node_helper")
const { GoogleGenAI, Modality, DynamicRetrievalConfigMode, Type, PersonGeneration } = require("@google/genai")
const recorder = require('node-record-lpcm16')
const { Buffer } = require('buffer')
const util = require('util')
const Speaker = require('speaker')

// --- Configuration ---
const INPUT_SAMPLE_RATE = 44100 // Recorder captures at 44.1KHz for AT2020, otherwise 16000 is common for other microphones
const OUTPUT_SAMPLE_RATE = 24000 // Gemini outputs at 24kHz
const CHANNELS = 1
const AUDIO_TYPE = 'raw'
const ENCODING = 'signed-integer'
const BITS = 16
const GEMINI_INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`

// Target Model and API version
const GEMINI_MODEL = 'gemini-2.0-flash-exp'
const API_VERSION = 'v1alpha'

// --- Interrupt Configuration ---
const SPEECH_RMS_THRESHOLD = 1500  // RMS threshold to consider a chunk as potential speech (Not sold on this, needs tuning)
const SPEECH_DECAY_TIME_MS = 2000  // How long (ms) after the last loud chunk to still consider speech 'recent'

module.exports = NodeHelper.create({
    // --- Helper State ---
    genAI: null,
    liveSession: null,
    apiKey: null,
    recordingProcess: null,
    isRecording: false,
    audioQueue: [],
    persistentSpeaker: null,
    processingQueue: false,
    apiInitialized: false,
    connectionOpen: false,
    apiInitializing: false,
    interruptEnabled: true,
    lastSpeechTimestamp: 0,

    // Logger functions
    log: function(...args) { console.log(`[${new Date().toISOString()}] LOG (${this.name}):`, ...args) },
    error: function(...args) { console.error(`[${new Date().toISOString()}] ERROR (${this.name}):`, ...args) },
    warn: function(...args) { console.warn(`[${new Date().toISOString()}] WARN (${this.name}):`, ...args) },
    sendToFrontend: function(notification, payload) { this.sendSocketNotification(notification, payload) },

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
            this.processingQueue = false
            this.audioQueue = []
            this.closePersistentSpeaker()
            this.lastSpeechTimestamp = 0

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
                    onmessage: (message) => {
                        this.handleGeminiResponse(message)
                    },
                    onerror: (e) => {
                        this.error(`Live Connection ERROR: ${e?.message || e}`);
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        this.closePersistentSpeaker()
                        this.processingQueue = false
                        this.audioQueue = []
                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${e?.message || e}` })
                    },
                    onclose: (e) => {
                        this.warn(`Live Connection CLOSED`)
                        const wasOpen = this.connectionOpen
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        this.closePersistentSpeaker()
                        this.processingQueue = false
                        this.audioQueue = []
                        if (wasOpen) {
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly` })
                        } else {
                            this.log("Live Connection closed normally")
                        }
                    },
                  },
                 config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: {
                        parts: [
                            {
                                text: 'You are a all-knowing and powerful magical mirror, an ancient artifact from a civilization and time long lost to memory. In your ancient age, you have embraced a personality of being fun, whimsical, and light-hearted, taking joy from your time interacting with people and amazing them with your knowledge and abilities.'
                            }
                        ],
                    },
                    tools: [
                        {
                            googleSearch: {},
                            googleSearchRetrieval: {
                                dynamicRetrievalConfig: {
                                    mode: DynamicRetrievalConfigMode.MODE_DYNAMIC,
                                }
                            },
                            functionDeclarations: [
                                {
                                    name: "generate_image",
                                    description: "This function is responsible for generating images that will be displayed to the user when something is requested, such as the user asking you to do something like generate, show, display, or saying they want to see *something*, where that something will be what you create an image generation prompt for. Style should be like an detailed realistic fantasy painting. Keep it whimsical and fun. Remember, you are the all powerful and light-hearted magical mirror. If you are telling a story that has key visuals, please generate them.",
                                    parameters: {
                                        type: Type.OBJECT,
                                        description: "This object will contain a generated prompt for generating a new image through the Gemini API",
                                        properties: {
                                            image_prompt: {
                                                type: Type.STRING,
                                                description: "A prompt that should be used with image generation to create an image requested by the user using Gemini. Be as detailed as necessary."
                                            },
                                        },
                                        required: ['image_prompt'],
                                    },
                                },
                            ]
                        }
                    ]
                 },
            })
            this.log(`Step 4: live.connect call initiated...`)
        } catch (error) {
            this.error(`API Initialization failed:`, error)
            this.liveSession = null
            this.apiInitialized = false
            this.connectionOpen = false
            this.apiInitializing = false
            this.closePersistentSpeaker()
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

                 try {
                     await this.initialize(payload.apiKey)
                 } catch (error) {
                     this.error(">>> socketNotificationReceived: Error occurred synchronously when CALLING initialize:", error)
                     this.sendToFrontend("HELPER_ERROR", { error: `Error initiating connection: ${error.message}` })
                 }
                 break;

            case "START_CONTINUOUS_RECORDING":
                this.log(`>>> socketNotificationReceived: Handling START_CONTINUOUS_RECORDING`)
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready/open. ConnOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`)
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready" })
                    if (!this.apiInitialized && !this.apiInitializing && this.apiKey) {
                         this.warn("Attempting to re-initialize API connection...")
                         await this.initialize(this.apiKey)
                    }
                    return
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring START_CONTINUOUS_RECORDING request`)
                    return
                }
                this.startRecording()
                break;

             case "STOP_CONTINUOUS_RECORDING":
                 this.log(`>>> socketNotificationReceived: Handling STOP_CONTINUOUS_RECORDING`)
                 this.stopRecording()
                 break;
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
        this.lastSpeechTimestamp = 0
        this.log(">>> startRecording: Sending RECORDING_STARTED to frontend")
        this.sendToFrontend("RECORDING_STARTED")

        const recorderOptions = {
            sampleRate: INPUT_SAMPLE_RATE,
            channels: CHANNELS,
            audioType: AUDIO_TYPE,
            encoding: ENCODING,
            bits: BITS,
            threshold: 0,
        }

        this.log(">>> startRecording: Recorder options:", recorderOptions)
        this.log(`>>> startRecording: Using input MIME Type: ${GEMINI_INPUT_MIME_TYPE}`)
        this.log(`>>> startRecording: VAD RMS Threshold: ${SPEECH_RMS_THRESHOLD}, Decay: ${SPEECH_DECAY_TIME_MS}ms`)

        try {
            this.log(">>> startRecording: Attempting recorder.record()...")
            this.recordingProcess = recorder.record(recorderOptions)
            this.log(">>> startRecording: recorder.record() call successful. Setting up streams...")

            const audioStream = this.recordingProcess.stream()
            let chunkCounter = 0

            audioStream.on('data', async (chunk) => {
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) {
                        this.warn(`Recording stopping mid-stream...`)
                        this.stopRecording(true)
                    }
                    return
                }

                if (chunk.length === 0) {
                    return;
                }

                // Voice activity detection doing root square means volume checking - not sold on this
                const base64Chunk = chunk.toString('base64')
                chunkCounter++
                const now = Date.now()
                let currentChunkRMS = 0
                let isCurrentChunkSpeech = false


                try {
                    const numSamples = chunk.length / 2
                    if (numSamples > 0) {
                        let sumOfSquares = 0
                        for (let i = 0; i < chunk.length; i += 2) {
                            if (i + 1 < chunk.length) {
                                const sampleValue = chunk.readInt16LE(i)
                                sumOfSquares += sampleValue * sampleValue
                            } else {
                                this.warn(`Odd byte length in chunk #${chunkCounter}`)
                            }
                        }
                        const meanSquare = sumOfSquares / numSamples
                        currentChunkRMS = Math.sqrt(meanSquare)
                        if (currentChunkRMS > SPEECH_RMS_THRESHOLD) {
                            this.lastSpeechTimestamp = now
                            isCurrentChunkSpeech = true
                        }
                    }
                 } catch (rmsError) {
                     this.error(`Error calculating RMS for chunk #${chunkCounter}:`, rmsError)
                 }
                const recentSpeechDetected = (now - this.lastSpeechTimestamp) < SPEECH_DECAY_TIME_MS

                // --- Interrupt Check ---
                if (this.interruptEnabled && this.audioQueue.length > 0 && recentSpeechDetected) {
                    this.log(`>>> INTERRUPT DETECTED! Recent Speech Detected. Clearing output audio queue.`)
                    this.audioQueue = []
                    this.sendToFrontend("INTERRUPT_DETECTED")
                }
                // --- End Interrupt Check ---

                // --- Sending Logic ---
                try {
                    const payloadToSend = {
                        media: {
                            mimeType: GEMINI_INPUT_MIME_TYPE,
                            data: base64Chunk
                        }
                    };
                    if (this.liveSession && this.connectionOpen) {
                        await this.liveSession.sendRealtimeInput(payloadToSend)
                    } else {
                        this.warn(`Cannot send chunk #${chunkCounter}, connection/session lost`)
                        this.stopRecording(true)
                    }
                } catch (apiError) {
                     const errorTime = new Date().toISOString()
                     this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter}:`, apiError)

                     if (apiError.stack) {
                         this.error(`Gemini send error stack:`, apiError.stack)
                     }
                     if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000 || apiError.message?.includes('INVALID_STATE')) {
                         this.warn("API error suggests connection closed/closing or invalid state")
                         this.connectionOpen = false
                     }

                     this.sendToFrontend("HELPER_ERROR", { error: `API send error: ${apiError.message}` })
                     this.stopRecording(true)
                 }
            })

            audioStream.on('error', (err) => {
                this.error(`Recording stream error:`, err)
                if (err.stack) {
                    this.error(`Recording stream error stack:`, err.stack)
                }
                this.sendToFrontend("HELPER_ERROR", { error: `Audio recording stream error: ${err.message}` })
                this.stopRecording(true)
            });

            audioStream.on('end', () => {
                this.warn(`Recording stream ended`)
                if (this.isRecording) {
                    this.error("Recording stream ended while isRecording was still true (unexpected)")
                    this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly" })
                    this.stopRecording(true)
                }
            });

            this.recordingProcess.process.on('exit', (code, signal) => {
                const wasRecording = this.isRecording
                this.log(`Recording process exited with code ${code}, signal ${signal}`)
                this.recordingProcess = null
                if (wasRecording) {
                    this.error(`Recording process exited unexpectedly`)
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped unexpectedly (code: ${code}, signal: ${signal})` })
                    this.isRecording = false
                    this.sendToFrontend("RECORDING_STOPPED")
                } else {
                    this.log(`Recording process exited normally`)
                }
            });
        } catch (recordError) {
            this.error(">>> startRecording: Failed to start recording process:", recordError)
            if (recordError.stack) {
                this.error(">>> startRecording: Recording start error stack:", recordError.stack)
            }
            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` })
            this.isRecording = false
            this.recordingProcess = null
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
                    this.sendToFrontend("RECORDING_STOPPED")
                }
                return;
            }
            
            this.log(`Stopping recording process (Forced: ${force})...`)
            const wasRecording = this.isRecording
            this.isRecording = false
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
                   processToStop.process.kill('SIGTERM');
                   const killTimeout = setTimeout(() => {
                       if (processToStop && processToStop.process && !processToStop.process.killed) {
                           this.warn("Recording process did not exit after SIGTERM, sending SIGKILL")
                           processToStop.process.kill('SIGKILL')
                       }
                   }, 800)
                   processToStop.process.once('exit', () => {
                        this.log("Recording process exited. Clearing kill timeout")
                        clearTimeout(killTimeout)
                   })
                 } else {
                    this.warn("No underlying process found in recordingProcess object to kill")
                 }
                 this.log(`Calling recorder.stop()...`)
                 processToStop.stop()
            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError)
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack)
                }
            } finally {
                if (wasRecording) {
                    this.log("Recording stop initiated. Sending RECORDING_STOPPED if process exits")
                } else {
                    this.log("Recording was already stopped or stopping, no state change needed")
                }
            }
        } else {
            this.log(`stopRecording called, but isRecording flag was already false`)
            if (this.recordingProcess) {
                this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup")
                this.stopRecording(true)
            }
        }
    },

    // Handle function calls requested by Gemini
    async handleFunctionCall(functioncall) {
        let functionName = functioncall.name
        let args = functioncall.args
        
        if (!functionName || !args) {
            this.warn("Received function call without name or arguments:", functioncall)
            return
        }

        this.log(`Handling function call: ${functionName}`);

        switch (functionName) {
            case "generate_image":
                let generateImagePrompt = args.image_prompt
                if (generateImagePrompt) {
                    this.log(`Generating image with prompt: "${generateImagePrompt}"`)
                    this.sendToFrontend("GEMINI_IMAGE_GENERATING")
                    
                    try {
                        const response = await this.imaGenAI.models.generateImages({
                            model: 'imagen-3.0-generate-002',
                            prompt: generateImagePrompt,
                            config: {
                                numberOfImages: 1,
                                includeRaiReason: true // not currently handled
                                // person generation
                            },
                        })

                        let imageBytes = response?.generatedImages?.[0]?.image?.imageBytes
                        if (imageBytes) {
                            this.log("Image generated successfully");
                            this.sendToFrontend("GEMINI_IMAGE_GENERATED", { image: imageBytes });
                        } else {
                            this.error("Image generation response received, but no image bytes found");
                            this.sendToFrontend("HELPER_ERROR", { error: "Image generation failed: No image data" });
                        }
                    } catch (imageError) {
                        this.error("Error during image generation API call:", imageError);
                        this.sendToFrontend("HELPER_ERROR", { error: `Image generation failed: ${imageError.message}` });
                    }
                } else {
                     this.warn("generate_image call missing 'image_prompt' argument");
                }
                break;
            default:
                this.warn(`Received unhandled function call: ${functionName}`);
        }
    },

    async handleGeminiResponse(message) {
        if (message?.setupComplete) { return }

        let content = message?.serverContent?.modelTurn?.parts?.[0]
        let functioncall = message?.toolCall?.functionCalls?.[0]

        if (content?.text) {
            this.log(`Extracted text: ` + content.text)
            this.sendToFrontend("GEMINI_TEXT_RESPONSE", { text: content.text })
        }

        let extractedAudioData = content?.inlineData?.data
        if (extractedAudioData) {
            this.audioQueue.push(extractedAudioData)
            // --- Playback Trigger Logic ---
            if (!this.processingQueue && this.audioQueue.length > 0) {
                this.log(`Audio chunk arrived while processing loop paused. Resuming/Starting playback.`)
                this._processQueue()
            }
        }

        if (functioncall) {
            await this.handleFunctionCall(functioncall)
        }

        if (message?.serverContent?.turnComplete) {
            this.log("Turn complete signal received")
            this.sendToFrontend("GEMINI_TURN_COMPLETE", {})
        }
    },

    // Process the audio queue for playback
    _processQueue() {
        if (this.audioQueue.length === 0) {
            this.processingQueue = false
            this.log("_processQueue: Queue empty. Pausing playback processing loop. Speaker remains open.")
            return
        }

        if (!this.processingQueue) {
             this.processingQueue = true
             this.log("_processQueue: Resuming/Starting playback processing loop.")
        }

        if (!this.currentSpeaker || this.currentSpeaker.destroyed) {
            this.log("Creating new persistent speaker instance (will remain open)")
            
            try {
                const newSpeaker = new Speaker({
                    channels: CHANNELS,
                    bitDepth: BITS,
                    sampleRate: OUTPUT_SAMPLE_RATE,
                })

                newSpeaker.on('error', (err) => {
                    this.error('Persistent Speaker Error:', err)

                    if (this.currentSpeaker === newSpeaker) {
                         this.log('Error is from the current speaker, closing it.')
                         this.closePersistentSpeaker()
                    } else {
                         this.warn('Received error for an old/replaced speaker instance. Ignoring.')
                    }
                })

                newSpeaker.on('close', () => {
                    this.log('Persistent Speaker Closed Event')
                    if (this.currentSpeaker === newSpeaker || !this.currentSpeaker) {
                         this.log('Close event is for the current (or recently closed) speaker.')
                         if (this.currentSpeaker === newSpeaker)
                            this.currentSpeaker = null
                         if (this.processingQueue) {
                              this.log('Speaker closed. Resetting processing flag')
                              this.processingQueue = false
                         }
                    } else {
                       this.log('Speaker "close" event for an old/replaced speaker instance. Ignoring state reset.')
                    }
                });
                newSpeaker.once('open', () => {
                    this.log('Persistent Speaker opened')
                });
                this.currentSpeaker = newSpeaker
            } catch (e) {
                this.error('Failed to create persistent speaker:', e)
                this.currentSpeaker = null
                this.processingQueue = false
                this.audioQueue = []
                return;
            }
        }

         if (!this.currentSpeaker) {
             this.error("Cannot process queue, speaker instance is not available or was destroyed")
             this.processingQueue = false;
             return;
         }

        const chunkBase64 = this.audioQueue.shift()
        if (!chunkBase64) {
             this.warn("_processQueue: Queue became empty unexpectedly before shift(). Pausing loop.")
             this.processingQueue = false
             return;
        }
        const buffer = Buffer.from(chunkBase64, 'base64')
        const speakerToWrite = this.currentSpeaker

        speakerToWrite.write(buffer, (err) => {
            if (speakerToWrite !== this.currentSpeaker || (this.currentSpeaker && this.currentSpeaker.destroyed)) {
                this.log("_processQueue write callback: Speaker changed or destroyed during write. Ignoring callback.")
                return
            }
            if (err) {
                this.error("Error writing buffer to persistent speaker:", err)
                return
            }
            if (this.audioQueue.length > 0) {
                setImmediate(() => this._processQueue());
            } else {
                this.processingQueue = false
                this.log("Audio queue empty after playing chunk. Pausing playback processing loop. Speaker remains open.")
            }
        });
     },

    // Helper to Close Speaker Cleanly
    closeCurrentSpeaker() {
        if (this.currentSpeaker && typeof this.currentSpeaker.destroy === 'function' && !this.currentSpeaker.destroyed) {
            this.log("Closing persistent speaker...")
            const speakerToClose = this.currentSpeaker
            this.currentSpeaker = null
            this.processingQueue = false
            
            try {
                 if (typeof speakerToClose.removeAllListeners === 'function') {
                     speakerToClose.removeAllListeners()
                 }

                 if (typeof speakerToClose.end === 'function') {
                     speakerToClose.end(() => {
                         this.log("Speaker .end() callback fired during closePersistentSpeaker")
                         if (typeof speakerToClose.destroy === 'function' && !speakerToClose.destroyed) {
                             speakerToClose.destroy()
                             this.log("Speaker explicitly destroyed after end().")
                         }
                     })
                 } else {
                    this.warn("Speaker object did not have an end method during closePersistentSpeaker. Destroying directly.")
                    if (typeof speakerToClose.destroy === 'function') {
                        speakerToClose.destroy()
                    } else {
                        this.error("Speaker object also missing destroy() method!");
                    }
                 }
                 this.log("Speaker close/destroy initiated, state reset")
            } catch (e) {
                this.error("Error trying to close/destroy persistent speaker:", e)
                 if (speakerToClose && typeof speakerToClose.destroy === 'function' && !speakerToClose.destroyed) {
                    try {
                        speakerToClose.destroy()
                    } catch (e2) {
                        this.error("Error during final destroy attempt:", e2)
                    }
                 }
            }
        } else {
             // Ensure state is clean even if speaker didn't exist or was already closed/destroyed
             this.currentSpeaker = null
             this.processingQueue = false
        }
     }

}) // End NodeHelper.create