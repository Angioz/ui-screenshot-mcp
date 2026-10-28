export interface ScreenshotOptions {
  url?: string;
  selector?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
  timeout?: number;
}

export interface ScreenshotResult {
  success: boolean;
  path: string;
  url?: string;
  timestamp: string;
  format: 'png' | 'jpeg';
  size?: {
    width: number;
    height: number;
  };
  error?: string;
}

export interface BrowserSession {
  id: string;
  url: string;
  width: number;
  height: number;
  cookies?: Array<{
    name: string;
    value: string;
  }>;
}

export interface MCPToolInput {
  [key: string]: unknown;
}
