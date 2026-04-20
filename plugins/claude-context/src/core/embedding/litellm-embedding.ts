import { Embedding, EmbeddingVector } from './base-embedding';

export interface LiteLLMEmbeddingConfig {
    baseUrl: string;      // e.g. http://localhost:14041
    apiKey: string;       // user's gateway API key
    model: string;        // e.g. local/nomic-embed-text
    dimension?: number;
    maxTokens?: number;
}

interface OpenAIEmbeddingResponse {
    data: Array<{ embedding: number[]; index: number; object: string }>;
    model: string;
    object: string;
    usage?: { prompt_tokens: number; total_tokens: number };
}

export class LiteLLMEmbedding extends Embedding {
    private config: LiteLLMEmbeddingConfig;
    private dimension: number = 0;
    private dimensionDetected: boolean = false;
    protected maxTokens: number = 2048;

    constructor(config: LiteLLMEmbeddingConfig) {
        super();
        this.config = config;
        if (!config.baseUrl) throw new Error('LiteLLMEmbedding: baseUrl required');
        if (!config.apiKey) throw new Error('LiteLLMEmbedding: apiKey required');
        if (!config.model) throw new Error('LiteLLMEmbedding: model required');

        if (config.dimension && config.dimension > 0) {
            this.dimension = config.dimension;
            this.dimensionDetected = true;
        }
        if (config.maxTokens && config.maxTokens > 0) {
            this.maxTokens = config.maxTokens;
        }
    }

    setModel(model: string): void {
        if (model !== this.config.model) {
            this.config.model = model;
            this.dimensionDetected = false;
            this.dimension = 0;
        }
    }

    async detectDimension(testText: string = 'dimension_probe'): Promise<number> {
        if (this.dimensionDetected && this.dimension > 0) return this.dimension;
        const res = await this.callEmbeddings([testText]);
        const vec = res.data?.[0]?.embedding;
        if (!Array.isArray(vec) || vec.length === 0) {
            throw new Error(`LiteLLMEmbedding: unable to detect dimension for ${this.config.model}`);
        }
        this.dimension = vec.length;
        this.dimensionDetected = true;
        return this.dimension;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        const processed = this.preprocessText(text);
        if (!this.dimensionDetected) await this.detectDimension(processed || 'dimension_probe');
        const res = await this.callEmbeddings([processed]);
        const vec = res.data?.[0]?.embedding;
        if (!Array.isArray(vec)) {
            throw new Error('LiteLLMEmbedding: response missing data[0].embedding');
        }
        return { vector: vec, dimension: vec.length };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        if (!texts.length) return [];
        const processed = this.preprocessTexts(texts);
        if (!this.dimensionDetected) await this.detectDimension(processed[0] || 'dimension_probe');
        try {
            const res = await this.callEmbeddings(processed);
            if (!Array.isArray(res.data) || res.data.length !== processed.length) {
                throw new Error(`LiteLLMEmbedding: batch length mismatch (got ${res.data?.length ?? 0}, expected ${processed.length})`);
            }
            const sorted = [...res.data].sort((a, b) => a.index - b.index);
            return sorted.map((d) => ({ vector: d.embedding, dimension: d.embedding.length }));
        } catch (err) {
            // Fall back to sequential
            const out: EmbeddingVector[] = [];
            for (const t of processed) out.push(await this.embed(t));
            return out;
        }
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return 'litellm';
    }

    getModel(): string {
        return this.config.model;
    }

    private async callEmbeddings(input: string[]): Promise<OpenAIEmbeddingResponse> {
        const url = this.config.baseUrl.replace(/\/$/, '') + '/v1/embeddings';
        const body = JSON.stringify({
            model: this.config.model,
            input: input.length === 1 ? input[0] : input,
        });
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`LiteLLMEmbedding: ${response.status} ${response.statusText} — ${text}`);
        }
        return (await response.json()) as OpenAIEmbeddingResponse;
    }
}
