export interface CodeChunk {
    content: string;
    metadata: {
        startLine: number;
        endLine: number;
        language?: string;
        filePath?: string;
    };
}

export enum SplitterType {
    LANGCHAIN = 'langchain',
}

export interface SplitterConfig {
    type?: SplitterType;
    chunkSize?: number;
    chunkOverlap?: number;
}

export interface Splitter {
    split(code: string, language: string, filePath?: string): Promise<CodeChunk[]>;
    setChunkSize(chunkSize: number): void;
    setChunkOverlap(chunkOverlap: number): void;
}

export * from './langchain-splitter';
