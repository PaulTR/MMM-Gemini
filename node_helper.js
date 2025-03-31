/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Modality } from '@google/genai';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import Speaker from 'speaker';
import { Writable } from 'node:stream';

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
// *** ADDED: Delay between audio chunks in milliseconds ***
const INTER_CHUNK_DELAY_MS = 250; // Adjust as needed (e.g., 250ms = 0.25 seconds)

// --- Audio Playback Handling ---
let audioQueue = [];
let isPlaying = false;

function queueAudioChunk(base64Data) {
    if (!base64Data) return;
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        audioQueue.push(buffer);
        // Trigger processing asynchronously. If already playing, it will wait.
        setImmediate(processNextAudioChunk);
    } catch (error) {
        console.error('\nError decoding base64 audio:', error);
    }
}

function processNextAudioChunk() {
    if (isPlaying || audioQueue.length === 0) {
        return;
    }

    isPlaying = true;
    const buffer = audioQueue.shift();
    let currentSpeaker = null;

    // --- Cleanup Function (Modified for Delay) ---
    const cleanupAndProceed = (speakerInstance, errorOccurred = false) => {
        if (!isPlaying) { return; } // Already cleaned up or wasn't playing

        isPlaying = false; // Release the lock *before* the delay

        if (speakerInstance && !speakerInstance.destroyed) {
            try { speakerInstance.destroy(); } catch (e) { console.warn("Warning: Error destroying speaker during cleanup:", e.message); }
        }
        currentSpeaker = null;

        // *** MODIFIED: Use setTimeout for delay before next chunk ***
        if (INTER_CHUNK_DELAY_MS > 0) {
            // console.log(`[cleanupAndProceed] Audio finished. Waiting ${INTER_CHUNK_DELAY_MS}ms before next check.`);
            setTimeout(() => {
                // console.log("[cleanupAndProceed] Delay finished. Checking for next chunk.");
                processNextAudioChunk(); // Check queue after delay
            }, INTER_CHUNK_DELAY_MS);
        } else {
            // If delay is 0, behave like setImmediate
            setImmediate(processNextAudioChunk);
        }
    };

    try {
        console.log(`\n[Playing audio chunk (${buffer.length} bytes)...]`);
        currentSpeaker = new Speaker({
            channels: CHANNELS, bitDepth: BIT_DEPTH, sampleRate: SAMPLE_RATE,
        });

        currentSpeaker.once('error', (err) => {
            console.error('\nSpeaker Error:', err.message);
            cleanupAndProceed(currentSpeaker, true); // Pass speaker instance
        });

        currentSpeaker.once('close', () => {
            // console.log('[Audio chunk finished]'); // Optional log
            cleanupAndProceed(currentSpeaker, false); // Pass speaker instance
        });

        if (currentSpeaker instanceof Writable && !currentSpeaker.destroyed) {
            currentSpeaker.write(buffer, (writeErr) => {
                if (writeErr && !currentSpeaker.destroyed) { console.error("\nError during speaker.write callback:", writeErr.message); }
            });
            currentSpeaker.end();
        } else {
            if (!currentSpeaker?.destroyed) console.error("\nError: Speaker instance is not writable or already destroyed before write.");
            cleanupAndProceed(currentSpeaker, true); // Pass speaker instance
        }

    } catch (speakerCreationError) {
        console.error("\nError creating Speaker instance:", speakerCreationError.message);
        cleanupAndProceed(currentSpeaker, true); // Pass potentially null speaker instance
    }
}

// --- Main Application Logic ---
async function live(client) {
  const responseQueue = [];
  let connectionClosed = false;

  async function waitMessage() {
    let done = false;
    let message = undefined;
    while (!done && !connectionClosed) {
      message = responseQueue.shift();
      if (message) { done = true; }
      else { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    return connectionClosed ? undefined : message;
  }

  const rl = readline.createInterface({ input, output });

  console.log('Connecting to Gemini Live API...');
  const session = await client.live.connect({
    model: 'gemini-2.0-flash-exp', // Make sure this model is appropriate for live API
    callbacks: {
      onopen: function () {
        console.log('\nConnection OPENED. Ready for input.');
        console.log('Type your message below or type "exit" to quit.');
        rl.prompt();
      },
      onmessage: function (message) {
        // --- START: ADDED LOGGING ---
        console.log("\n--- Raw API Message Received ---");
        console.dir(message, { depth: null, colors: true }); // Log the entire message object with full depth and colors
        console.log("--- End Raw API Message ---");
        // --- END: ADDED LOGGING ---

        responseQueue.push(message); // Still push to queue for processing
      },
      onerror: function (e) {
        console.error('\nConnection ERROR:', e?.message || e);
        connectionClosed = true; audioQueue = []; isPlaying = false; rl.close();
      },
      onclose: function (e) {
        if (!connectionClosed) {
          console.log('\nConnection CLOSED:', e?.reason || 'Closed by server');
          connectionClosed = true; audioQueue = []; isPlaying = false; rl.close();
        }
      },
    },
    config: { responseModalities: [Modality.AUDIO] }, // Only Audio
  });

  rl.setPrompt('You: ');

  rl.on('line', async (line) => {
    const inputText = line.trim();
    if (inputText.toLowerCase() === 'exit') {
      console.log('Exiting...'); rl.close(); return;
    }
    if (connectionClosed) {
      console.log("Cannot send message, connection is closed."); rl.prompt(); return;
    }

    try {
      // Log the text being sent for context
      console.log(`\n[Sending text: "${inputText}"]`);
      session.sendClientContent({ turns: inputText }); // Sending text only

      let modelTurnComplete = false;
      while (!modelTurnComplete && !connectionClosed) {
        const message = await waitMessage();
        if (!message) {
          if (!connectionClosed) { console.log("\nConnection closed while waiting for response."); connectionClosed = true; }
          break;
        }

        // Process parts (audio queuing)
        const parts = message?.serverContent?.modelTurn?.parts;
        if (parts && Array.isArray(parts)) {
            for (const part of parts) {
                // Check specifically for audio/pcm data
                if (part.inlineData &&
                    part.inlineData.mimeType === `audio/pcm;rate=${SAMPLE_RATE}` &&
                    part.inlineData.data)
                {
                    queueAudioChunk(part.inlineData.data); // Queue audio chunk
                }
                // You could add logging for other part types here if needed
                // else if (part.text) {
                //   console.log("\n[Received text part]:", part.text); // Example if you enabled text modality
                // }
            }
        }

        // Check if the model's turn is complete for this message
        if (message?.serverContent?.turnComplete === true) {
          console.log("\n[Model Turn Complete marker received]");
          modelTurnComplete = true;
          let waitCount = 0;
          // Wait for audio queue AND active playback to finish before prompting again
          while (isPlaying || audioQueue.length > 0) {
              if (waitCount % 20 === 0 && waitCount > 0) { /* Log less often */ console.log(`[Waiting for audio queue (${audioQueue.length}) and playback (${isPlaying})...]`); }
              await new Promise(resolve => setTimeout(resolve, 50));
              waitCount++;
          }
          console.log('\n' + '-'.repeat(20)); // Separator after all audio for the turn is done
        }

        // Check for finish reason (e.g., error, safety)
        const finishReason = message?.serverContent?.candidates?.[0]?.finishReason;
         if (finishReason && finishReason !== "STOP" && !modelTurnComplete) {
             console.warn(`\n[Model stopped processing with reason: ${finishReason}]`);
             modelTurnComplete = true; // Treat as turn complete if there's a non-STOP finish reason
             let waitCount = 0;
             // Wait for any remaining queued audio to finish
             while (isPlaying || audioQueue.length > 0) {
                 if (waitCount % 20 === 0 && waitCount > 0) { console.log(`[Waiting for audio queue (${audioQueue.length}) and playback (${isPlaying}) after finish reason: ${finishReason}...]`); }
                 await new Promise(resolve => setTimeout(resolve, 50));
                 waitCount++;
             }
             console.log('\n' + '-'.repeat(20)); // Separator
         }
      }
    } catch (error) {
      console.error('\nError during send/receive loop:', error);
      connectionClosed = true; audioQueue = []; isPlaying = false; rl.close(); return;
    }

    if (!connectionClosed) { rl.prompt(); }

  }).on('close', () => {
    console.log('\nReadline closed. Cleaning up...');
    if (!connectionClosed) {
        try { session.close(); } catch(e) { console.warn("Error closing session:", e.message); }
        connectionClosed = true;
    }
    audioQueue = []; isPlaying = false;
    console.log('Session finished.'); process.exit(0);
  });
}

// --- Main function ---
async function main() {
  if (!GEMINI_API_KEY) {
    console.error("Error: GEMINI_API_KEY environment variable is not set."); process.exit(1);
  }
  const client = new GoogleGenAI({
    vertexai: false, // Assuming you are using Google AI Studio key, not Vertex AI
    apiKey: GEMINI_API_KEY,
    httpOptions: { apiVersion: 'v1alpha' }, // Use v1alpha for live API
  });
  try {
    await live(client);
  } catch (e) {
    console.error('Unhandled error setting up live session:', e);
    process.exit(1);
  }
}

main();