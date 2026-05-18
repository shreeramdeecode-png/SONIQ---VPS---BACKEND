const { execSync } = require('child_process');
const PORT = process.env.PORT || 5000;

try {
    const output = execSync('netstat -ano').toString();
    const line = output.split('\n').find(
        l => l.includes(`:${PORT} `) && l.includes('LISTENING')
    );
    if (line) {
        const pid = line.trim().split(/\s+/).pop();
        execSync(`taskkill /PID ${pid} /F`);
        console.log(`Freed port ${PORT} (PID ${pid})`);
    }
} catch {
    // port is already free
}
