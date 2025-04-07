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
    
    // Start the proxy server with pipe to parent for output
    server = require('child_process').spawn('node', ['app.test.js'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Handle server output
    let serverStarted = false;
    server.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Faleproxy server running')) {
        serverStarted = true;
      }
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server failed to start within timeout'));
      }, 5000);

      const checkServer = setInterval(() => {
        if (serverStarted) {
          clearInterval(checkServer);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);
    });
  }, 10000); // Increase timeout for server startup

  afterAll(async () => {
    // Clean up both servers
    if (server) {
      server.kill();
      await new Promise(resolve => server.on('exit', resolve));
    }
    if (contentServer) {
      await new Promise(resolve => contentServer.close(resolve));
    }
    await execAsync('rm app.test.js');
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
