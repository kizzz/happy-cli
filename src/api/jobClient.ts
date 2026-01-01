import axios from 'axios';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';

export interface Job {
    id: string;
    type: 'claude' | 'codex';
    status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    priority: number;
    metadata?: Record<string, any>;
    machineId?: string;
    sessionId?: string;
    config?: string; // Encrypted
    input?: string; // Encrypted
    output?: string; // Encrypted
    error?: string; // Encrypted
    timeoutMs?: number; // Timeout in milliseconds
    retryCount?: number; // Number of retries attempted
    maxRetries?: number; // Maximum number of retries
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    completedAt?: number;
}

export interface CreateJobRequest {
    type: 'claude' | 'codex';
    config: string; // Encrypted
    input: string; // Encrypted
    sessionId?: string;
    metadata?: Record<string, any>;
    priority?: number;
    machineId?: string;
    timeoutMs?: number; // Timeout in milliseconds
    maxRetries?: number; // Maximum number of retries
}

export interface ListJobsResponse {
    jobs: Array<Omit<Job, 'config' | 'input' | 'output' | 'error'>>;
}

export interface GetJobResponse {
    job: Job;
}

export interface CreateJobResponse {
    job: Omit<Job, 'config' | 'input' | 'output' | 'error'>;
}

export class JobClient {
    constructor(private readonly token: string) {}

    /**
     * Create a new job
     */
    async createJob(request: CreateJobRequest): Promise<CreateJobResponse> {
        try {
            const response = await axios.post<CreateJobResponse>(
                `${configuration.serverUrl}/v1/jobs`,
                request,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );
            logger.debug(`[JobClient] Job created: ${response.data.job.id}`);
            return response.data;
        } catch (error) {
            logger.debug('[JobClient] Failed to create job:', error);
            throw new Error(`Failed to create job: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Get job by ID
     */
    async getJob(jobId: string): Promise<GetJobResponse> {
        try {
            const response = await axios.get<GetJobResponse>(
                `${configuration.serverUrl}/v1/jobs/${jobId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`
                    },
                    timeout: 30000
                }
            );
            return response.data;
        } catch (error) {
            logger.debug('[JobClient] Failed to get job:', error);
            throw new Error(`Failed to get job: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * List jobs for account
     */
    async listJobs(options?: {
        status?: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
        limit?: number;
        cursor?: string;
    }): Promise<ListJobsResponse> {
        try {
            const response = await axios.get<ListJobsResponse>(
                `${configuration.serverUrl}/v1/jobs`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`
                    },
                    params: options,
                    timeout: 30000
                }
            );
            return response.data;
        } catch (error) {
            logger.debug('[JobClient] Failed to list jobs:', error);
            throw new Error(`Failed to list jobs: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Cancel a job
     */
    async cancelJob(jobId: string): Promise<void> {
        try {
            await axios.delete(
                `${configuration.serverUrl}/v1/jobs/${jobId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`
                    },
                    timeout: 30000
                }
            );
            logger.debug(`[JobClient] Job cancelled: ${jobId}`);
        } catch (error) {
            logger.debug('[JobClient] Failed to cancel job:', error);
            throw new Error(`Failed to cancel job: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Retry a failed job
     */
    async retryJob(jobId: string): Promise<CreateJobResponse> {
        try {
            const response = await axios.post<CreateJobResponse>(
                `${configuration.serverUrl}/v1/jobs/${jobId}/retry`,
                {},
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );
            logger.debug(`[JobClient] Job retried: ${jobId} -> ${response.data.job.id}`);
            return response.data;
        } catch (error) {
            logger.debug('[JobClient] Failed to retry job:', error);
            throw new Error(`Failed to retry job: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Get pending jobs for a machine
     */
    async getPendingJobsForMachine(machineId: string, limit: number = 10): Promise<ListJobsResponse> {
        try {
            const response = await axios.get<ListJobsResponse>(
                `${configuration.serverUrl}/v1/jobs`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`
                    },
                    params: {
                        status: 'pending',
                        limit
                    },
                    timeout: 30000
                }
            );
            // Filter by machineId on client side (server doesn't filter by machineId yet)
            return {
                jobs: response.data.jobs.filter(job => job.machineId === machineId || !job.machineId)
            };
        } catch (error) {
            logger.debug('[JobClient] Failed to get pending jobs:', error);
            throw new Error(`Failed to get pending jobs: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Update job status
     */
    async updateJobStatus(jobId: string, status: 'running' | 'completed' | 'failed', output?: string, error?: string): Promise<void> {
        try {
            await axios.post(
                `${configuration.serverUrl}/v1/jobs/${jobId}/status`,
                {
                    status,
                    output,
                    error
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
            logger.debug(`[JobClient] Job status updated: ${jobId} -> ${status}`);
        } catch (error) {
            logger.debug('[JobClient] Failed to update job status:', error);
            throw new Error(`Failed to update job status: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}

