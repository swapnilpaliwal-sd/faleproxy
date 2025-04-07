const axios = require('axios');
const cheerio = require('cheerio');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { sampleHtmlWithYale } = require('./test-utils');
const http = require('http');

// Set different ports for testing to avoid conflict with the main app
const TEST_PORT = 3099;
const CONTENT_SERVER_PORT = 3098;
let server;
let contentServer;

// Helper function to wait for port to be available
async function waitForPort(port, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await axios.get(`http://localhost:${port}`);
      return true;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

// Set longer timeout for the entire test suite
jest.setTimeout(30000);

describe('Integration Tests', () => {
  // Set up test environment
  beforeAll(async () => {
    // Create and start the content server
    contentServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(sampleHtmlWithYale);
    });
    
    await new Promise(resolve => {
      contentServer.listen(CONTENT_SERVER_PORT, resolve);
    });
    
    // Create a temporary test app file
    await execAsync('cp app.js app.test.js');
    // Handle both macOS and Linux sed syntax
    const sedCommand = process.platform === 'darwin'
      ? `sed -i '' 's/const PORT = 3001/const PORT = ${TEST_PORT}/' app.test.js`
      : `sed -i 's/const PORT = 3001/const PORT = ${TEST_PORT}/' app.test.js`;
    await execAsync(sedCommand);
    
    // Start the proxy server
    server = require('child_process').spawn('node', ['app.test.js'], {
      stdio: 'pipe'
    });

    // Handle server output and errors
    server.stdout.on('data', data => {
      const output = data.toString();
      // Only log startup message
      if (output.includes('Faleproxy server running')) {
        console.log('Test server started successfully');
      }
    });
    
    server.stderr.on('data', data => {
      const error = data.toString();
      // Only log actual errors, not expected ones
      if (!error.includes('Invalid URL')) {
        console.error('Server error:', error);
      }
    });
    
    // Handle server exit
    server.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`Server exited with code ${code}`);
      }
    });

    // Wait for server to be ready
    try {
      await waitForPort(TEST_PORT);
    } catch (error) {
      console.error('Server failed to start:', error);
      throw error;
    }
  }, 10000); // Increase timeout for server startup

  afterAll(async () => {
    // Clean up both servers
    try {
      if (server) {
        server.kill();
        await Promise.race([
          new Promise(resolve => server.on('exit', resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Server kill timeout')), 5000))
        ]);
      }
    } catch (error) {
      // Silently try force kill if normal kill fails
      try {
        process.kill(server.pid, 'SIGKILL');
      } catch (e) {
        // Ignore errors during force kill
      }
    }

    try {
      if (contentServer) {
        await Promise.race([
          new Promise(resolve => contentServer.close(resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Content server close timeout')), 5000))
        ]);
      }
    } catch (error) {
      // Ignore content server close errors
    }

    try {
      await execAsync('rm app.test.js');
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('Should replace Yale with Fale in fetched content', async () => {
    // Make a request to our proxy app using the content server
    const response = await axios.post(`http://localhost:${TEST_PORT}/fetch`, {
      url: `http://localhost:${CONTENT_SERVER_PORT}/`
    });
    
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    
    // Verify Yale has been replaced with Fale in text
    const $ = cheerio.load(response.data.content);
    expect($('title').text()).toBe('Fale University Test Page');
    expect($('h1').text()).toBe('Welcome to Fale University');
    expect($('p').first().text()).toContain('Fale University is a private');
    
    // Verify URLs remain unchanged
    const links = $('a');
    let hasYaleUrl = false;
    links.each((i, link) => {
      const href = $(link).attr('href');
      if (href && href.includes('yale.edu')) {
        hasYaleUrl = true;
      }
    });
    expect(hasYaleUrl).toBe(true);
    
    // Verify link text is changed
    expect($('a').first().text()).toBe('About Fale');
  }, 10000); // Increase timeout for this test

  test('Should handle invalid URLs', async () => {
    try {
      await axios.post(`http://localhost:${TEST_PORT}/fetch`, {
        url: 'not-a-valid-url'
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error.isAxiosError).toBe(true);
      expect(error.response?.status || 500).toBe(500);
    }
  });

  test('Should handle missing URL parameter', async () => {
    try {
      await axios.post(`http://localhost:${TEST_PORT}/fetch`, {});
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error.isAxiosError).toBe(true);
      expect(error.response?.status || 400).toBe(400);
      expect(error.response?.data?.error || '').toBe('URL is required');
    }
  });
});
