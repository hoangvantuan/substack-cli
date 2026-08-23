/**
 * The environment object every part of the CLI sees. Nothing beneath runCli
 * touches the outside world directly; it goes through these capabilities.
 */

export interface Writer {
  write(text: string): void;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Header names are normalised to lowercase. */
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Creates the directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface StdinSource {
  /** Reads standard input to completion. */
  read(): Promise<string>;
}

export interface Env {
  http: HttpClient;
  fs: FileSystem;
  stdin: StdinSource;
  stdout: Writer;
  stderr: Writer;
  /** Returns the current time as epoch milliseconds. */
  clock(): number;
  /** Sleeps for the given number of milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Environment variables by name. */
  vars: Record<string, string | undefined>;
  homedir(): string;
}
