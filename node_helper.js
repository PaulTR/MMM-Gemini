/* node_helper.js - Persistent Speaker, Queue, Waits for Turn Complete - CORRECTED Config */

const NodeHelper = require("node_helper")
const { GoogleGenAI, Modality, DynamicRetrievalConfigMode, Type } = require("@google/genai")
const recorder = require('node-record-lpcm16')
const { Buffer } = require('buffer')
const util = require('util')

const Speaker = require('speaker')
const { Readable } = require('stream')

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
    persistentSpeaker: null,
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
        this.persistentSpeaker = null
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
            // Should already be null on initial call, but if we need to reconnect we'll want to reset these
            this.persistentSpeaker = null
            this.processingQueue = false
            this.audioQueue = []

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
                        this.log(">>> Live Connection Callback: onmessage triggered.")
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
                        this.persistentSpeaker = null
                        this.processingQueue = false
                        this.audioQueue = []

                        this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Error: ${errorMessage}` })
                    },
                    onclose: (e) => {
                        this.log(">>> Live Connection Callback: onclose triggered!")
                        this.warn(`Live Connection CLOSED Event Received at ${new Date().toISOString()}.`)
                        this.warn(`Live Connection CLOSE Event Object:`, util.inspect(e, { depth: 5 }))

                        const wasOpen = this.connectionOpen
                        this.connectionOpen = false
                        this.apiInitializing = false
                        this.apiInitialized = false
                        this.liveSession = null
                        this.stopRecording(true)
                        this.persistentSpeaker = null
                        this.processingQueue = false
                        this.audioQueue = []

                        if (wasOpen) { 
                            this.sendToFrontend("HELPER_ERROR", { error: `Live Connection Closed Unexpectedly.` })
                            // *** This might cause a loop if things go poorly, but the goal is that when the live connection automatically times out, we can just reopen.
                            // Not ideal if you're looking to constantly have your mirror running, you may want to add some logic to detect a volume threshold, then initialize everything
                            // but for a demo, this is good enough ***
                            initialize(apiKey)
                        }
                        else { 
                            this.log("Live Connection closed normally or was already closed.")
                        }
                    },
                },

                config: {
                    // responseModalities: [Modality.AUDIO],
                    responseModalities: [Modality.TEXT],
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
                    }] // Keep your commented preference
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
            this.persistentSpeaker = null
            this.processingQueue = false
            this.audioQueue = []

            this.sendToFrontend("HELPER_ERROR", { error: `API Initialization failed: ${error.message || error}` })
        }
    },


    // --- Socket Notification Handler ---
    socketNotificationReceived: async function(notification, payload) {
        // this.log(`>>> socketNotificationReceived: Received notification: ${notification}`)

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
                     this.initialize(payload.apiKey)
                     this.log(`>>> socketNotificationReceived: Called initialize.`)
                } catch (error) {
                    this.error(">>> socketNotificationReceived: Error occurred synchronously when CALLING initialize:", error)
                }
                break

            case "START_CONTINUOUS_RECORDING":
                this.log(`>>> socketNotificationReceived: Handling START_CONTINUOUS_RECORDING.`)
                if (!this.connectionOpen || !this.liveSession) {
                    this.warn(`Cannot start recording, API connection not ready/open. ConnOpen=${this.connectionOpen}, SessionExists=${!!this.liveSession}`)
                    this.sendToFrontend("HELPER_ERROR", { error: "Cannot record: API connection not ready." })
                    if (!this.apiInitialized && !this.apiInitializing && this.apiKey) {
                         this.warn("Attempting to re-initialize API connection...")
                         this.initialize(this.apiKey)
                    }
                    return
                }
                if (this.isRecording) {
                    this.warn(`Already recording. Ignoring START_CONTINUOUS_RECORDING request.`)
                    return
                }
                this.startRecording()
                break
        }
    },

    // --- Continuous audio recording ---
    // This is using bidirectional live streaming. There's also turn-based live streaming, but that works best for text or controlled (something to indicate start and stop) audio inputs
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
             this.log(">>> startRecording: recorder.record() call successful (process object created). Setting up streams...")

            const audioStream = this.recordingProcess.stream()
            let chunkCounter = 0

            audioStream.on('data', async (chunk) => {
                const checkTime = new Date().toISOString()
                if (!this.isRecording || !this.connectionOpen || !this.liveSession) {
                    if (this.isRecording) {
                        this.warn(`[${checkTime}] Recording stopping: Session/Connection invalid...`)
                        this.stopRecording(true)
                    }
                    else {
                        this.log("Ignoring data chunk, recording stopped.")
                    }
                    return
                }

                if (chunk.length === 0) {
                    this.log(`[${checkTime}] Received empty data chunk #${++chunkCounter}. Skipping.`)
                    return
                }

                const base64Chunk = chunk.toString('base64')

                try {
                    const sendTime = new Date().toISOString()
                    const payloadToSend = { media: { mimeType: GEMINI_INPUT_MIME_TYPE, data: base64Chunk } }
                    // this.log(`[${sendTime}] Attempting sendRealtimeInput for chunk #${++chunkCounter}...`)

                    await this.liveSession.sendRealtimeInput(payloadToSend)

                    // this.log(`[${new Date().toISOString()}] sendRealtimeInput succeeded.`)
                } catch (apiError) {
                    const errorTime = new Date().toISOString()
                    this.error(`[${errorTime}] Error sending audio chunk #${chunkCounter}:`, apiError)

                    if (apiError.stack) {
                        this.error(`Gemini send error stack:`, apiError.stack)
                    }

                    if (apiError.message?.includes('closed') || apiError.message?.includes('CLOSING') || apiError.code === 1000) {
                         this.warn("API error suggests connection closed/closing...")
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
            })

             audioStream.on('end', () => {
                 this.warn(`Recording stream ended unexpectedly.`)
                 if (this.isRecording) {
                      this.error("Recording stream ended while isRecording true.")
                      this.sendToFrontend("HELPER_ERROR", { error: "Recording stream ended unexpectedly." })
                      this.stopRecording(true)
                 }
             })

            this.recordingProcess.process.on('exit', (code, signal) => {
                this.warn(`Recording process exited with code ${code}, signal ${signal}.`)

                if (this.isRecording) {
                    this.error(`Recording process exited unexpectedly.`)
                    this.sendToFrontend("HELPER_ERROR", { error: `Recording process stopped (code: ${code}, signal: ${signal})` })
                    this.stopRecording(true)
                }
                else {
                    this.log(`Recording process exited normally.`)
                }
                
                this.recordingProcess = null
            })

        } catch (recordError) {
            this.error(">>> startRecording: Failed to start recording process in try/catch:", recordError)

            if (recordError.stack) {
                this.error(">>> startRecording: Recording start error stack:", recordError.stack)
            }

            this.sendToFrontend("HELPER_ERROR", { error: `Failed to start recording: ${recordError.message}` })

            this.isRecording = false
            this.recordingProcess = null
        }
    },

    stopRecording(force = false) {
        // Check if there is an active recording process instance
        if (!this.recordingProcess) {
             this.log(`stopRecording called but no recording process instance exists.`)
             
             // Check for state discrepancy
             if (this.isRecording) {
                  this.warn("State discrepancy: isRecording was true but no process found. Resetting state.")
                  this.isRecording = false
                  
                  // Send stopped notification only if we thought we were recording
                  this.sendToFrontend("RECORDING_STOPPED")
             }

             return
        }

        // Check if recording is active or if forced stop
        if (this.isRecording || force) {
            this.log(`Stopping recording process (Forced: ${force})...`)
            const wasRecording = this.isRecording
            this.isRecording = false // Set flag immediately to prevent race conditions (building this project was an exercise in understanding state)

            try {
                const stream = this.recordingProcess.stream()
                if (stream) {
                    // Remove listeners to prevent memory leaks or handling events after stop
                    this.log("Removing stream listeners ('data', 'error', 'end').")
                    stream.removeAllListeners('data')
                    stream.removeAllListeners('error')
                    stream.removeAllListeners('end')
                    stream.unpipe() // Important for stream cleanup
                }

                 if (this.recordingProcess.process) {
                    // Remove process exit listener
                    this.log("Removing process listener ('exit').")
                    this.recordingProcess.process.removeAllListeners('exit')

                    // Attempt to kill the underlying process (e.g., arecord)
                    // Gently first (SIGTERM), then forcefully (SIGKILL) if needed
                    this.log("Sending SIGTERM to recording process.")
                    this.recordingProcess.process.kill('SIGTERM')
                    // Give it a moment to exit gracefully before forcing
                    setTimeout(() => {
                        // Check if the process reference still exists and if it wasn't killed yet
                        // Need null check for this.recordingProcess in case timeout fires after stop() completes fully
                        if (this.recordingProcess && this.recordingProcess.process && !this.recordingProcess.process.killed) {
                            this.warn("Recording process did not exit after SIGTERM, sending SIGKILL.")
                            this.recordingProcess.process.kill('SIGKILL')
                        }
                    }, 500) // Wait 500ms before SIGKILL
                 }

                 // Call the library's stop method, which might also attempt to kill the process
                 // Place this after attempting our own kill/cleanup
                 this.recordingProcess.stop()
                 this.log(`Recorder stop() called.`)

            } catch (stopError) {
                this.error(`Error during recorder cleanup/stop():`, stopError)
                if (stopError.stack) {
                    this.error(`Recorder stop() error stack:`, stopError.stack)
                }
                // Even if cleanup fails, ensure the reference is cleared
            } finally {
                this.recordingProcess = null // Clear the reference to the process object
                // Notify frontend only if recording was actively stopped
                if (wasRecording) {
                    this.log("Sending RECORDING_STOPPED to frontend.")
                    this.sendToFrontend("RECORDING_STOPPED")
                } else {
                     this.log("Recording was already stopped or stopping, no RECORDING_STOPPED sent this time.")
                }
            }
        } else {
            // This case means stopRecording() was called, but isRecording was already false
            this.log(`stopRecording called, but isRecording flag was already false.`)
             // Defensive cleanup if process still exists somehow (shouldn't happen with proper state management)
            if (this.recordingProcess) {
                 this.warn("stopRecording called while isRecording=false, but process existed. Forcing cleanup.")
                 this.stopRecording(true) // Force stop to clean up the zombie process
            }
        }
    }, // --- End stopRecording ---


    // --- Gemini Response Handling ---
    async handleGeminiResponse(message) {
        // this.log(`Received message structure from Gemini:`, JSON.stringify(message, null, 2))

        if (message?.setupComplete) {
            this.log("Received setupComplete message from Gemini (ignoring for playback).")
            return
        }

        let extractedTextData = message?.serverContent?.modelTurn?.parts?.[0]?.text
        if( extractedTextData ) {
            this.log(`Extracted text: ` + extractedTextData)
            this.sendToFrontend("GEMINI_TEXT_RESPONSE", { text: extractedTextData })
            return
        } else {
            this.warn(`No text data found...`)
        }

        // --- Extract Audio Data ---
        let extractedAudioData = null
        try {
            extractedAudioData = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data
        } catch (e) {
             this.error("Error trying to access audio data in serverContent structure:", e)
        }

        // Queue Audio Data if found
        if (extractedAudioData) {
            this.log(`Extracted valid audio data (length: ${extractedAudioData.length}). Adding to queue.`)
            this.audioQueue.push(extractedAudioData)
            this.log(`Audio added to queue. Queue size: ${this.audioQueue.length}`)
            return
        } else {
             this.log(`Received Gemini message but found no 'audio' data in the expected location.`)
        }

        let functioncall = message?.toolCall?.functionCalls?.[0]

        if(functioncall) {
            // Only checking for image generation as a function call
            let functionName = functioncall.name
            let generateImagePrompt = functioncall.args?.image_prompt
            if(functionName && generateImagePrompt) {
                switch(functionName) {
                case "generate_image": // TODO think about moving this into its own function
                    this.log("****** Entering image generate ******")
                    this.log(`****** prompt ****** : ${generateImagePrompt}`)
                    const response = await this.imaGenAI.models.generateImages({
                        model: 'imagen-3.0-generate-002',
                        prompt: generateImagePrompt,
                        config: {
                            numberOfImages: 1,
                            includeRaiReason: true
                        },
                    })
                    this.log(`Received image response from Gemini:`, JSON.stringify(response, null, 2))
                    // TODO handle RaiReason
                }
            }
        }

        /*
            Playback starts ONLY when turn is complete AND queue has items
            There's some decisions you could make here - you can play all of the chunks as they come in,
            but then you have some pauses/hiccups during the initial playback chunks
            With this queue method, playback is smooth, but also delayed while it waits for the turnComplete message to come through
            I valued clean output over speed for this project, but feel free to change anything you want
        */
        if (message?.serverContent?.turnComplete) {
            this.log("Turn complete signal received.")
            if (this.audioQueue.length > 0) {
                 this.log(`Triggering queue processing. Queue size: ${this.audioQueue.length}`)
                 this._processQueue()
            } else {
                this.log("Turn complete, but audio queue is empty (perhaps audio was blocked or not sent, such as using Modality.TEXT).")
                 // Ensure processing flag is false if queue is empty on turn complete
                 this.processingQueue = false
            }

            this.sendToFrontend("GEMINI_TURN_COMPLETE", { })
            return
        }

        this.warn(`Not sending GEMINI_RESPONSE notification as no actionable content was extracted.`)

        // TODO: Handle blocked prompt
    },

    _processQueue() {
        // Prevent re-entry if already processing or queue is empty
        if (this.processingQueue || this.audioQueue.length === 0) {
            this.log(`_processQueue called but skipping. Processing: ${this.processingQueue}, Queue Size: ${this.audioQueue.length}`)

            // Ensure flag reset if queue empty
            if (this.audioQueue.length === 0) {
                this.processingQueue = false
            }

            return
        }

        this.processingQueue = true
        this.log(`_processQueue started. Queue size: ${this.audioQueue.length}`)

        // Ensure speaker exists and is ready, create if needed
        if (!this.persistentSpeaker || this.persistentSpeaker.destroyed) {
            this.log("Creating new persistent speaker instance.")
            try {
                this.persistentSpeaker = new Speaker({
                    channels: CHANNELS,
                    bitDepth: BITS,
                    sampleRate: OUTPUT_SAMPLE_RATE,
                })

                // --- Setup listeners once per speaker instance ---
                this.persistentSpeaker.on('error', (err) => {
                    this.error('Persistent Speaker Error:', err)
                    if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) { 
                        try { 
                            this.persistentSpeaker.destroy()
                        } catch (e) {
                            this.error("Error destroying speaker on error:", e)
                        }
                    }

                    this.persistentSpeaker = null
                    this.processingQueue = false
                })

                this.persistentSpeaker.on('close', () => {
                    this.log('Persistent Speaker Closed.')
                    this.persistentSpeaker = null
                    this.processingQueue = false
                })

                this.persistentSpeaker.on('open', () => this.log('Persistent Speaker opened.'))
                this.persistentSpeaker.on('flush', () => this.log('Persistent Speaker flushed.'))

            } catch (e) {
                this.error('Failed to create persistent speaker:', e)
                this.processingQueue = false
                this.persistentSpeaker = null
                return
            }
        }

        if (!this.persistentSpeaker) {
             this.error("Cannot process queue, speaker instance is not available.")
             this.processingQueue = false
             return
        }

        // Process one chunk at a time using the write callback
        const chunkBase64 = this.audioQueue.shift()

        if (!chunkBase64) {
             this.warn("_processQueue: Dequeued an empty or invalid chunk.")
             this.processingQueue = false
             this._processQueue()
             return
        }

        const buffer = Buffer.from(chunkBase64, 'base64')
        this.log(`Writing chunk (length ${buffer.length}) to speaker. Queue remaining: ${this.audioQueue.length}`)

        this.persistentSpeaker.write(buffer, (err) => {
            if (err) {
                this.error("Error writing buffer to persistent speaker:", err)
                if (this.persistentSpeaker && !this.persistentSpeaker.destroyed) {
                    try {
                        this.persistentSpeaker.destroy()
                    } catch (e) {
                        this.error("Error destroying speaker on write error:", e)
                    }
                }

                this.persistentSpeaker = null
                this.processingQueue = false
            } else {
                this.log(`Finished writing chunk.`)
                this.processingQueue = false // Mark this chunk done
                this._processQueue() // Call again immediately to process next item if any
            }
        })
    },
})