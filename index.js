const net = require('net');
const bitcoin = require('bitcoin');
const winston = require('winston');
const async = require('async');
const express = require('express');
const moment = require('moment');

// Configure logging first
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'proxy.log' })
    ]
});

// Initialize the Bitcoin client
const client = new bitcoin.Client({
    host: 'localhost',
    port: 5555,
    user: 'Mills',
    pass: 'Mills'
});

// Constants
const ALGORITHMS = {
    'progpow-veil': 'progpow',
    'sha256d': 'sha256d',
    'randomx-veil': 'randomx'
};

const EXTRA_NONCE_BYTES = 4;
const PROTOCOL_VERSION = "2.0.0";

// Initialize global variables
const clients = new Set();
const currentJobs = new Map();
let jobCounter = 0;

// Express server setup
const app = express();
const PORT = 3333;
const MONITOR_PORT = 3334;

// Node status check function
async function checkNodeStatus() {
    return new Promise((resolve, reject) => {
        client.getBlockchainInfo((err, info) => {
            if (err) {
                logger.error('Error getting blockchain info:', err);
                reject(err);
                return;
            }
            
            if (!info) {
                reject(new Error('No blockchain info received'));
                return;
            }

            logger.info(`Node status - Blocks: ${info.blocks}, Headers: ${info.headers}, Sync: ${(info.verificationprogress * 100).toFixed(2)}%`);
            
            const isSynced = info.verificationprogress > 0.999;
            
            if (!isSynced) {
                logger.warn(`Node is not fully synced (${(info.verificationprogress * 100).toFixed(2)}%). Mining may not work correctly.`);
            }
            
            resolve({
                isSynced,
                blocks: info.blocks,
                headers: info.headers,
                verificationProgress: info.verificationprogress
            });
        });
    });
}

// Function to get difficulty for each algorithm
function getDifficultyForAlgo(algo) {
    switch(algo) {
        case 'progpow':
            return 0.002;
        case 'sha256d':
            return 0.01;
        case 'randomx':
            return 0.005;
        default:
            return 0.01; 
    }
}

// Create mining job based on algorithm
async function createMiningJob(algo) {
    if (!algo) {
        throw new Error('Algorithm not specified');
    }

    try {
        const nodeStatus = await checkNodeStatus();
        if (!nodeStatus.isSynced) {
            throw new Error(`Node is not fully synced (${(nodeStatus.verificationProgress * 100).toFixed(2)}%). Please wait for sync completion.`);
        }
    } catch (error) {
        logger.error('Failed to check node status:', error);
        throw error;
    }

    return new Promise((resolve, reject) => {
        client.getblocktemplate({ rules: ['segwit'] }, (err, template) => {
            if (err) {
                if (err.code === -10 || err.message.includes('syncing') || err.message.includes('loading')) {
                    logger.error('Node is not ready:', err.message);
                    reject(new Error('Node is not ready for mining. Please wait for sync completion.'));
                    return;
                }
                
                logger.error('Error getting block template:', err);
                reject(err);
                return;
            }

            if (!template) {
                reject(new Error('No template received from node'));
                return;
            }

            const job = {
                job_id: `${algo}-${++jobCounter}`,
                algorithm: algo,
                prevhash: template.previousblockhash,
                coinbase: template.coinbasetxn,
                version: template.version,
                nbits: template.bits,
                ntime: template.curtime,
                clean_jobs: true,
                difficulty: getDifficultyForAlgo(algo)
            };

            // Algorithm-specific modifications
            switch (algo) {
                case 'progpow':
                    job.progpow_header = template.progpow_header;
                    job.progpow_mix_hash = template.progpow_mix_hash;
                    break;
                case 'sha256d':
                    job.merkle = template.merkle_root;
                    break;
                case 'randomx':
                    job.seed_hash = template.randomx_seed;
                    break;
            }

            currentJobs.set(job.job_id, job);
            resolve(job);
        });
    });
}

// ... (rest of your functions remain the same) ...

// Server startup function
async function startServer() {
    try {
        // Check initial node status
        const nodeStatus = await checkNodeStatus();
        if (!nodeStatus.isSynced) {
            logger.warn(`Starting server with partially synced node (${(nodeStatus.verificationProgress * 100).toFixed(2)}%). Mining may not work correctly until fully synced.`);
        }

        // Create stratum server
        const server = net.createServer((socket) => {
            const client = {
                socket,
                algorithm: null,
                authorized: true,
                wallet: 'local_worker',
                difficulty: null,
                connected: moment().utc().format('YYYY-MM-DD HH:mm:ss')
            };

            clients.add(client);
            logger.info(`New connection from ${socket.remoteAddress}`);

            socket.on('data', (data) => {
                const messages = data.toString().split('\n');
                messages.forEach(async (message) => {
                    if (!message) return;

                    try {
                        const parsed = JSON.parse(message);
                        const response = await handleStratumMethod(client, parsed);
                        if (response) {
                            socket.write(JSON.stringify(response) + '\n');
                        }
                    } catch (error) {
                        logger.error('Error processing message:', error);
                        socket.write(JSON.stringify({
                            id: null,
                            error: 'Invalid message',
                            result: null
                        }) + '\n');
                    }
                });
            });

            socket.on('end', () => {
                clients.delete(client);
                logger.info(`Client disconnected: ${client.wallet || 'unauthorized'}`);
            });

            socket.on('error', (error) => {
                logger.error('Socket error:', error);
                clients.delete(client);
            });
        });
// ... (keep all previous code up to the createMiningJob function) ...

// Add this function before startServer
async function handleStratumMethod(client, message) {
    const { id, method, params } = message;
    
    logger.info(`Received method: ${method}, id: ${id}, params: ${JSON.stringify(params)}`);

    try {
        switch (method) {
            case 'mining.subscribe':
                const [userAgent = 'wildrig-multi', protocol = PROTOCOL_VERSION, clientId] = params;
                if (!ALGORITHMS['progpow-veil']) {
                    return {
                        id,
                        error: 'Unsupported algorithm',
                        result: null
                    };
                }
                
                // Set default algorithm for WildRig
                client.algorithm = 'progpow';
                client.difficulty = getDifficultyForAlgo(client.algorithm);
                client.extraNonce = Buffer.from('00'.repeat(EXTRA_NONCE_BYTES), 'hex');
                
                // Send difficulty first
                client.socket.write(JSON.stringify({
                    id: null,
                    method: 'mining.set_difficulty',
                    params: [client.difficulty]
                }) + '\n');

                logger.info(`Miner subscribed with user agent: ${userAgent}`);

                // Modified subscription response for WildRig
                const subscribeResponse = {
                    id,
                    result: [
                        [
                            ["mining.set_difficulty", "b4b6693b72a50c7116db18d6497cac52"],
                            ["mining.notify", "ae6812eb4cd7735a302a8a9dd95cf71f"]
                        ],
                        client.extraNonce.toString('hex'),
                        EXTRA_NONCE_BYTES
                    ],
                    error: null
                };
                
                client.socket.write(JSON.stringify(subscribeResponse) + '\n');

                // Send initial job immediately
                try {
                    const job = await createMiningJob(client.algorithm);
                    sendMiningJob(client, job);
                } catch (err) {
                    logger.error('Error creating initial job:', err);
                }

                return null; // Already sent response

            case 'mining.authorize':
                // Always authorize
                const response = {
                    id,
                    result: true,
                    error: null
                };
                client.socket.write(JSON.stringify(response) + '\n');
                logger.info(`Authorized client: ${params[0]}`);
                return null;

            case 'mining.submit':
                const [worker, jobId, nonce, header, mixHash] = params;
                
                logger.info(`Received share submission - jobId: ${jobId}, nonce: ${nonce}`);
                
                const submission = {
                    algo: client.algorithm,
                    worker: worker || 'local_worker',
                    jobId,
                    nonce,
                    header,
                    mixHash
                };

                try {
                    await submitWork(submission);
                    logger.info(`Share accepted: ${worker} [${client.algorithm}]`);
                    return {
                        id,
                        result: true,
                        error: null
                    };
                } catch (error) {
                    logger.error(`Share rejected: ${worker} [${client.algorithm}] - ${error.message}`);
                    return {
                        id,
                        error: error.message,
                        result: null
                    };
                }

            default:
                logger.warn(`Unknown method received: ${method}`);
                return {
                    id,
                    error: `Unknown method ${method}`,
                    result: null
                };
        }
    } catch (error) {
        logger.error('Error handling stratum method:', error);
        return {
            id,
            error: 'Internal error',
            result: null
        };
    }
}

// Add the sendMiningJob function
function sendMiningJob(client, job) {
    if (!client.socket) return;

    const miningNotify = {
        id: null,
        method: 'mining.notify',
        params: [
            job.job_id,
            job.prevhash,
            job.coinbase1 || '',
            job.coinbase2 || '',
            job.merkle_branch || [],
            job.version,
            job.nbits,
            job.ntime,
            true // clean_jobs
        ]
    };

    try {
        client.socket.write(JSON.stringify(miningNotify) + '\n');
        logger.info(`Sent job ${job.job_id} to client`);
    } catch (error) {
        logger.error('Error sending job:', error);
        clients.delete(client);
    }
}

// Add the submitWork function
async function submitWork(submission) {
    return new Promise((resolve, reject) => {
        // Format parameters based on algorithm
        let params;
        switch (submission.algo) {
            case 'progpow':
                params = [submission.header, submission.mixHash, submission.nonce];
                break;
            default:
                params = [submission.header, submission.nonce];
                break;
        }

        client.submitblock(params, (err, result) => {
            if (err) {
                logger.error('Submit work error:', err);
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

// ... (keep the rest of your code including startServer and the server startup) ...

        // Start servers
        server.listen(PORT, '0.0.0.0', () => {
            logger.info(`Stratum proxy server started on port ${PORT}`);
        });

        app.listen(MONITOR_PORT, '0.0.0.0', () => {
            logger.info(`Monitoring server started on port ${MONITOR_PORT}`);
        });

        // Add periodic node status check
        setInterval(async () => {
            try {
                const status = await checkNodeStatus();
                if (!status.isSynced) {
                    logger.warn(`Node sync status: ${(status.verificationProgress * 100).toFixed(2)}%`);
                }
            } catch (error) {
                logger.error('Failed to check node status:', error);
            }
        }, 60000); // Check every minute

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer().catch(error => {
    logger.error('Fatal error starting server:', error);
    process.exit(1);
});
