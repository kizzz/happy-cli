/**
 * Job Executor
 * 
 * Executes a single job by spawning a temporary session, running the task,
 * collecting the result, and uploading it back to the server.
 */

/**
 * Job Executor
 * 
 * Executes a single job by spawning a temporary session, running the task,
 * collecting the result, and uploading it back to the server.
 */

import { logger } from '@/ui/logger';
import { ApiClient } from '@/api/api';
import { JobClient, type Job } from '@/api/jobClient';
import { Credentials } from '@/persistence';
import { CodexMcpClient } from '@/codex/codexMcpClient';
import type { CodexSessionConfig } from '@/codex/types';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import os from 'node:os';
import packageJson from '../../package.json';
import { encodeBase64, encrypt, decrypt, decodeBase64 } from '@/api/encryption';
import { query } from '@/claude/sdk';
import type { SDKUserMessage } from '@/claude/sdk/types';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { getProjectPath } from '@/claude/utils/path';
import { mkdirSync } from 'node:fs';

export interface JobExecutionOptions {
    job: Job;
    credentials: Credentials;
    machineId: string;
    timeoutMs?: number;
}

interface JobExecutionResult {
    success: boolean;
    output?: string; // Encrypted
    error?: string; // Encrypted
}

/**
 * Execute a single job
 */
export async function executeJob(options: JobExecutionOptions): Promise<void> {
    const { job, credentials, machineId, timeoutMs = 30 * 60 * 1000 } = options; // Default 30 minutes

    logger.debug(`[JobExecutor] Starting job execution: ${job.id}, type: ${job.type}`);

    if (!job.config || !job.input) {
        throw new Error('Job missing required config or input');
    }

    // Use job timeout if available, otherwise use default
    const effectiveTimeout = job.timeoutMs || timeoutMs;
    
    const jobClient = new JobClient(credentials.token);

    // Update job status to running
    try {
        await jobClient.updateJobStatus(job.id, 'running');
    } catch (error) {
        logger.debug(`[JobExecutor] Failed to update job status to running: ${job.id}`, error);
        // Continue anyway - job might have been cancelled
    }

    // Get encryption key from credentials
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    
    if (credentials.encryption.type === 'legacy') {
        encryptionKey = credentials.encryption.secret;
        encryptionVariant = 'legacy';
    } else {
        // For dataKey type, we'd need to derive the data key
        // For now, throw an error - this needs proper implementation
        throw new Error('Data key encryption not yet supported for job execution');
    }

    // Decrypt job config and input (they're base64-encoded encrypted strings from the server)
    let configStr: string;
    let inputStr: string;
    
    try {
        if (!job.config || !job.input) {
            throw new Error('Job missing required config or input');
        }
        
        // Decode from base64 and decrypt
        const decryptedConfig = decrypt(encryptionKey, encryptionVariant, decodeBase64(job.config));
        const decryptedInput = decrypt(encryptionKey, encryptionVariant, decodeBase64(job.input));
        
        if (!decryptedConfig || !decryptedInput) {
            throw new Error('Failed to decrypt job config or input');
        }
        
        // Config is stored as an object, input is stored as a string
        // Both are JSON.parse'd by decrypt(), so config is an object and input is a string
        configStr = typeof decryptedConfig === 'string' ? decryptedConfig : JSON.stringify(decryptedConfig);
        inputStr = typeof decryptedInput === 'string' ? decryptedInput : String(decryptedInput);
    } catch (error) {
        logger.debug(`[JobExecutor] Failed to decrypt job data: ${job.id}`, error);
        throw new Error(`Failed to decrypt job data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
        let result: JobExecutionResult;

        if (job.type === 'codex') {
            result = await executeCodexJob(job.id, configStr, inputStr, credentials, machineId, effectiveTimeout);
        } else if (job.type === 'claude') {
            result = await executeClaudeJob(job.id, configStr, inputStr, credentials, machineId, effectiveTimeout);
        } else {
            throw new Error(`Unsupported job type: ${job.type}`);
        }

        logger.debug(`[JobExecutor] Job execution completed: ${job.id}, success: ${result.success}`);

        // Encrypt output/error before uploading to server
        let encryptedOutput: string | undefined;
        let encryptedError: string | undefined;
        
        if (result.success && result.output) {
            const encrypted = encrypt(encryptionKey, encryptionVariant, result.output);
            encryptedOutput = encodeBase64(encrypted);
        } else if (result.error) {
            const encrypted = encrypt(encryptionKey, encryptionVariant, result.error);
            encryptedError = encodeBase64(encrypted);
        }

        // Update job status on server
        if (result.success) {
            await jobClient.updateJobStatus(job.id, 'completed', encryptedOutput);
        } else {
            await jobClient.updateJobStatus(job.id, 'failed', undefined, encryptedError);
        }
    } catch (error) {
        logger.debug(`[JobExecutor] Job execution failed: ${job.id}`, error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Get encryption key for error encryption
        let encryptionKey: Uint8Array;
        let encryptionVariant: 'legacy' | 'dataKey';
        
        if (credentials.encryption.type === 'legacy') {
            encryptionKey = credentials.encryption.secret;
            encryptionVariant = 'legacy';
        } else {
            // For dataKey, we can't encrypt the error properly
            // But we should still try to update status
            logger.debug(`[JobExecutor] Cannot encrypt error for dataKey type, sending unencrypted`);
            try {
                await jobClient.updateJobStatus(job.id, 'failed', undefined, errorMessage);
            } catch (updateError) {
                logger.debug(`[JobExecutor] Failed to update job status to failed: ${job.id}`, updateError);
            }
            return;
        }
        
        // Encrypt error message before uploading
        const encryptedError = encodeBase64(encrypt(encryptionKey, encryptionVariant, errorMessage));
        
        // Update job status to failed
        try {
            await jobClient.updateJobStatus(job.id, 'failed', undefined, encryptedError);
        } catch (updateError) {
            logger.debug(`[JobExecutor] Failed to update job status to failed: ${job.id}`, updateError);
        }
    }
}

/**
 * Execute a Codex job
 */
async function executeCodexJob(
    jobId: string,
    configStr: string,
    inputStr: string,
    credentials: Credentials,
    machineId: string,
    timeoutMs: number
): Promise<JobExecutionResult> {
    logger.debug(`[JobExecutor] Executing Codex job: ${jobId}`);

    // Parse config (configStr is already decrypted, should be JSON string)
    let config: CodexSessionConfig;
    try {
        // configStr might be a JSON string or already an object string representation
        config = JSON.parse(configStr);
    } catch (e) {
        // If parsing fails, try to construct a minimal config
        logger.debug(`[JobExecutor] Failed to parse config as JSON, using defaults: ${e}`);
        config = {
            prompt: inputStr
        };
    }

    // Ensure prompt is set to job input
    config.prompt = inputStr;

    // Create API client for session (needed for happy MCP server)
    const api = await ApiClient.create(credentials);
    
    // Create a temporary session for the job
    const sessionTag = `job-${jobId}`;
    const response = await api.getOrCreateSession({
        tag: sessionTag,
        metadata: {
            path: config.cwd || process.cwd(),
            host: os.hostname(),
            version: packageJson.version,
            os: process.platform,
            machineId: machineId,
            flavor: 'codex-job'
        },
        state: {
            controlledByUser: false
        }
    });

    const sessionClient = api.sessionSyncClient(response);

    // Start Happy MCP server (needed for codex integration)
    const happyServer = await startHappyServer(sessionClient);
    const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = {
        happy: {
            command: bridgeCommand,
            args: ['--url', happyServer.url]
        }
    };

    // Add MCP servers to config
    config.config = {
        ...config.config,
        mcp_servers: mcpServers
    };

    // Create Codex MCP client
    const codexClient = new CodexMcpClient();
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
        logger.debug(`[JobExecutor] Job timeout: ${jobId}`);
        codexClient.disconnect().catch(() => {});
    }, timeoutMs);

    try {
        // Connect to Codex
        await codexClient.connect();

        // Execute the job
        const response = await codexClient.startSession(config, {
            signal: AbortSignal.timeout(timeoutMs)
        });

        // Collect output from response
        let output = '';
        if (response.content) {
            if (Array.isArray(response.content)) {
                output = response.content
                    .map((item: any) => {
                        if (item.type === 'text' && item.text) {
                            return item.text;
                        }
                        return JSON.stringify(item);
                    })
                    .join('\n');
            } else if (typeof response.content === 'string') {
                output = response.content;
            }
        }

        clearTimeout(timeoutId);
        await codexClient.disconnect();

        // Output will be encrypted by the JobClient when uploading
        return {
            success: true,
            output: output
        };
    } catch (error) {
        clearTimeout(timeoutId);
        await codexClient.disconnect().catch(() => {});
        throw error;
    }
}

/**
 * Execute a Claude job
 */
async function executeClaudeJob(
    jobId: string,
    configStr: string,
    inputStr: string,
    credentials: Credentials,
    machineId: string,
    timeoutMs: number
): Promise<JobExecutionResult> {
    logger.debug(`[JobExecutor] Executing Claude job: ${jobId}`);

    // Parse config
    let config: any;
    try {
        config = JSON.parse(configStr);
    } catch (e) {
        logger.debug(`[JobExecutor] Failed to parse config as JSON, using defaults: ${e}`);
        config = {};
    }

    const workingDirectory = config.cwd || process.cwd();
    
    // Ensure project directory exists
    const projectDir = getProjectPath(workingDirectory);
    mkdirSync(projectDir, { recursive: true });

    // Create API client for session
    const api = await ApiClient.create(credentials);
    
    // Create a temporary session for the job
    const sessionTag = `job-${jobId}`;
    const response = await api.getOrCreateSession({
        tag: sessionTag,
        metadata: {
            path: workingDirectory,
            host: os.hostname(),
            version: packageJson.version,
            os: process.platform,
            machineId: machineId,
            flavor: 'claude-job'
        },
        state: {
            controlledByUser: false
        }
    });

    const sessionClient = api.sessionSyncClient(response);

    // Start Happy MCP server (needed for Claude integration)
    const happyServer = await startHappyServer(sessionClient);
    logger.debug(`[JobExecutor] Happy MCP server started at ${happyServer.url}`);

    // Set up timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
        logger.debug(`[JobExecutor] Job timeout: ${jobId}`);
        abortController.abort();
    }, timeoutMs);

    try {
        // Use Claude SDK query function for single message execution
        const messages = new PushableAsyncIterable<SDKUserMessage>();
        messages.push({
            type: 'user',
            message: {
                role: 'user',
                content: inputStr,
            },
        });

        // Build MCP servers config
        const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
        const mcpServers = {
            happy: {
                command: bridgeCommand,
                args: ['--url', happyServer.url]
            },
            ...(config.mcpServers || {})
        };

        // Query Claude SDK
        const sdkQuery = query({
            prompt: messages,
            options: {
                cwd: workingDirectory,
                mcpServers: mcpServers,
                allowedTools: config.allowedTools || [],
                abort: abortController.signal,
                canCallTool: async () => {
                    // For jobs, auto-approve all tools (or use config setting)
                    return { behavior: 'allow' as const, updatedInput: {} };
                },
                model: config.model,
                permissionMode: config.permissionMode || 'default',
            }
        });

        // Collect output from response
        let output = '';
        let lastMessage: any = null;

        try {
            for await (const message of sdkQuery) {
                lastMessage = message;
                
                // Extract text content from message
                if (message.type === 'assistant' && message.message?.content) {
                    const content = message.message.content;
                    if (Array.isArray(content)) {
                        const textParts = content
                            .filter((item: any) => item.type === 'text')
                            .map((item: any) => item.text || '');
                        if (textParts.length > 0) {
                            output = textParts.join('\n');
                        }
                    } else if (typeof content === 'string') {
                        output = content;
                    }
                } else if (message.type === 'text' && message.text) {
                    output = message.text;
                }
            }
        } catch (queryError) {
            if (abortController.signal.aborted) {
                throw new Error('Job execution timeout');
            }
            throw queryError;
        }

        clearTimeout(timeoutId);

        // If no output collected, use last message as fallback
        if (!output && lastMessage) {
            output = JSON.stringify(lastMessage);
        }

        return {
            success: true,
            output: output || 'No output generated'
        };
    } catch (error) {
        clearTimeout(timeoutId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`[JobExecutor] Claude job execution failed: ${jobId}`, error);
        return {
            success: false,
            error: errorMessage
        };
    }
}

