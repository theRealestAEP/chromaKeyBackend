import { t, Elysia } from "elysia";
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');
import { cors } from '@elysiajs/cors'
import { Database } from "bun:sqlite";

const chromaKeyVideo = (inputPath: string, outputPath: string, color: string, similarity: number, blend: number, frameDirectory: string): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        ffmpeg()
            .input(inputPath)
            .videoFilter(`colorkey=color=${color}:similarity=${similarity}:blend=${blend}`)
            .outputOptions('-c:v', 'libvpx')
            .outputOptions('-auto-alt-ref', '0')
            .outputOptions('-pix_fmt', 'yuva420p')
            .save(outputPath)
            // .on("progress", (progress) => console.log(progress))
            .on('end', () => {
                console.log('Chroma keying completed.');
                cleanupFiles(inputPath, frameDirectory);
                resolve(); // Resolve without a value
            })
            .on('error', (err) => {
                console.error('Error during chroma keying:', err);
                cleanupFiles(inputPath, frameDirectory);
                reject(err);
            })
            .run();
    });
};




const extractFrames = async (videoPath: string, taskId: string, frameRate = 1): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
        const frameDirectory = path.join(__dirname, `frames-${taskId}`);
        if (!fs.existsSync(frameDirectory)) {
            fs.mkdirSync(frameDirectory);
        }
        console.log('Starting frame extraction for:', videoPath);

        ffmpeg(videoPath)
            .save(`${frameDirectory}/frame-%03d.jpg`)
            .noAudio()
            .videoFilters(`fps=fps=${frameRate}`)
            .on("progress", progress => console.log('Frame extraction progress:', progress))
            .on('error', error => {
                console.error('Error during frame extraction:', error);
                reject(error)
            })
            .on('end', () => {
                console.log('Frame extraction completed.');
                resolve(frameDirectory);
            })
            .run();
    });
}

const findMostCommonColor = async (imagePath: string) => {
    console.log('getting most common color')
    try {
        const image = await Jimp.read(imagePath);
        const colorCounts: Record<string, number> = {};

        image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x: any, y: any) {
            const hex = Jimp.intToRGBA(image.getPixelColor(x, y));
            // Convert each color component to a hex string and pad with zeros if necessary
            const hexString = [
                hex.r.toString(16).padStart(2, '0'),
                hex.g.toString(16).padStart(2, '0'),
                hex.b.toString(16).padStart(2, '0')
            ].join('');

            colorCounts[hexString] = (colorCounts[hexString] || 0) + 1;
        });

        let mostCommonColor = Object.keys(colorCounts).reduce((a, b) => colorCounts[a] > colorCounts[b] ? a : b);

        mostCommonColor = mostCommonColor.padStart(6, '0');

        console.log(mostCommonColor)
        return `#${mostCommonColor}`;
    } catch (error) {
        console.error("An error occurred:", error);
        return null;
    }
}


interface AnalyzeVideoResult {
    mostCommonColor: string;
    frameDirectory: string;
}

const analyzeVideo = async (videoPath: string, taskId: string): Promise<AnalyzeVideoResult | null> => {
    try {
        console.log('getting Frame');
        // Ensure frameDirectory is declared as a string
        const frameDirectory: string = await extractFrames(videoPath, taskId);
        console.log(frameDirectory);

        const files = fs.readdirSync(frameDirectory);
        const colorCounts: Record<string, number> = {};

        for (let file of files) {
            const color = await findMostCommonColor(path.join(frameDirectory, file));
            if (color !== null) {
                colorCounts[color] = (colorCounts[color] || 0) + 1;
            }
        }

        let mostCommonColor = Object.keys(colorCounts).reduce((a, b) => colorCounts[a] > colorCounts[b] ? a : b);
        console.log('most common color')
        return { mostCommonColor, frameDirectory };
    } catch (error) {
        console.error("An error occurred:", error);
        return null;
    }
}


const cleanupFiles = (filePath: string, frameDirectory: string) => {
    console.log(`Cleaning up files for ${filePath}\n`)
    // Delete the uploaded video file
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    // Delete the extracted frames
    if (fs.existsSync(frameDirectory)) {
        console.log('Deleting frame directory:', frameDirectory);
        fs.readdirSync(frameDirectory).forEach((file: any) => {
            fs.unlinkSync(path.join(frameDirectory, file));
        });
        fs.rmdirSync(frameDirectory);
    }
};

interface TaskInfo {
    status: 'processing' | 'completed' | 'error';
    downloadLink?: string;
    error?: string;
}

const db = new Database("taskIDs.sqlite", { create: true })
const init = db.query("CREATE TABLE IF NOT EXISTS tasks (taskId TEXT PRIMARY KEY, status TEXT, downloadLink TEXT)");
await init.run();


const processVideo = async (taskId: string, filePath: string, outputPath: string): Promise<void> => {
    try {
        const insertOrUpdateTask = db.query("INSERT INTO tasks (taskId, status, downloadLink) VALUES (?, ?, ?) ON CONFLICT(taskId) DO UPDATE SET status=?, downloadLink=?");
        insertOrUpdateTask.run(taskId, 'processing', null, 'processing', null);

        const analysisResult = await analyzeVideo(filePath, taskId);

        if (analysisResult && analysisResult.mostCommonColor) {
            await chromaKeyVideo(filePath, outputPath, analysisResult.mostCommonColor, 0.2, 0.2, analysisResult.frameDirectory);
            const downloadLink = `/download/${path.basename(outputPath)}`;
            const updateTask = db.query("UPDATE tasks SET status=?, downloadLink=? WHERE taskId=?");
            updateTask.run('completed', downloadLink, taskId);
        } else {
            throw new Error('Chroma key analysis failed');
        }
    } catch (error: any) {
        console.error('Error in processing video:', error);
        if (error.message) {
            // taskStatusMap.set(taskId, { status: 'error', error: error.message });
            // let errorMessage = error.message ? error.message : 'Unknown error';
            console.error('Error in processing video:', error);
            const updateTaskError = db.query("UPDATE tasks SET status=?, downloadLink=NULL WHERE taskId=?");
            updateTaskError.run('error', taskId);
        }
    }
}

const app = new Elysia();
app.use(cors())
const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

const ensureDirectoryExists = (dir: string) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}



app.onError(({ code, error }) => {
    console.error('Error occurred:', error);
    let status
    switch (code) {
        case 'NOT_FOUND':
            status = 404;
            return 'Not Found';
        case 'INTERNAL_SERVER_ERROR':
            status = 500;
            return 'Internal Server Error';
        default:
            status = 500;
            return new Response(error.toString(), { status: status })
    }
});

// Ensure both directories exist
ensureDirectoryExists(uploadDir);
ensureDirectoryExists(outputDir);

app.post("/upload", async (ctx: any) => {
    // console.log(ctx)
    console.log(typeof (ctx.body.video))

    const f = ctx.body.video;
    let status
    if (!f) {
        status = 400
        // return { error: 'No video file provided' };
        return new Response('No video file provided', { status: status })
    }

    const MAX_SIZE = 50 * 1024 * 1024; // 50 MB in bytes
    if (f.size > MAX_SIZE) {
        // ctx.status = 413
        status = 413
        return new Response('No video file provided', { status: status })
    }

    try {
        const taskId = uuidv4();
        const fileName = `${taskId}.mp4`;
        const fileNameOut = `${taskId}.webm`;
        const filePath = `${uploadDir}/${fileName}`;
        const outputPath = `${outputDir}/${fileNameOut}`;

        await Bun.write(Bun.file(filePath), f);

        // Start the asynchronous video processing
        processVideo(taskId, filePath, outputPath);

        // Immediately respond with the taskId
        // ctx.status = 200;
        // ctx.body = { taskId };
        return { taskId };
    }
    catch (error) {
        console.error('Error in /upload route:', error);
        // ctx.status = 500;
        return new Response('Error Processing Video', { status: 500 })
    }
}
    ,
    {
        body: t.Object({
            video: t.Object({}) // Assuming the video is represented as a string, adjust accordingly
        })
    }
);

app.get("/download/:fileName", async (ctx: any) => {
    const fileName = ctx.params.fileName;
    const filePath = path.join(outputDir, fileName);

    if (!fs.existsSync(filePath)) {
        ctx.status = 404;
        // ctx.body = 'File not found';

        // return { error: 'File not found' }
        return new Response('File not found', { status: 404 })
    }
    // Directly set the body to the read stream
    // ctx.body = fs.createReadStream(filePath);
    return Bun.file(filePath);
    // return ctx.body
}, {
    params: t.Object({
        fileName: t.String() // Validate fileName as a string
    })
});

interface TaskRow {
    status: 'processing' | 'completed' | 'error';
    downloadLink?: string;
    // Include other columns if there are more
}

const getTaskInfo = async (taskId: string): Promise<TaskInfo | undefined> => {
    try {
        // Prepare and execute your query
        const getTaskQuery = db.query("SELECT status, downloadLink FROM tasks WHERE taskId = ?");
        const taskRow = await getTaskQuery.get(taskId) as TaskRow | undefined;


        if (taskRow) {
            const taskInfo: TaskInfo = {
                status: taskRow.status,
                downloadLink: taskRow.downloadLink, // This will be undefined if downloadLink is null in the database
            };
            return taskInfo; // This is automatically wrapped in a Promise because of async
        } else {
            return undefined; // This is automatically wrapped in a Promise because of async
        }
    } catch (error) {
        console.error('Error fetching task info:', error);
        return undefined; // This is automatically wrapped in a Promise because of async
    }
}

app.get("/status/:taskId", async (ctx: any) => {
    const taskId: string = ctx.params.taskId;
    const taskInfo = await getTaskInfo(taskId);

    if (!taskInfo) {
        // ctx.status = 404
        // return { error: 'Task not found' };
        return new Response('Task not found', { status: 404 })
    }
    return { taskInfo }
}, {
    params: t.Object({
        taskId: t.String() // Validate taskId as a string
    })
})

app.get("/test", async () => {
    return "ALIVE"
})


const handleInterruptedTasks = async () => {
    try {
        const interruptedTasksQuery = db.query("SELECT taskId FROM tasks WHERE status = 'processing'");
        const interruptedTasks = await interruptedTasksQuery.all() as { taskId: string }[];

        if (interruptedTasks.length > 0) {
            console.log(`Found ${interruptedTasks.length} interrupted tasks. Updating status to 'failed'.`);
            const updateTaskStatus = db.query("UPDATE tasks SET status='failed' WHERE taskId=?");

            for (const task of interruptedTasks) {
                await updateTaskStatus.run(task.taskId);
                const inputPath = `${uploadDir}/${task.taskId}.mp4`;
                const frameDirectory = path.join(__dirname, `frames-${task.taskId}`);

                cleanupFiles(inputPath, frameDirectory);
            }
        }
    } catch (error) {
        console.error('Error handling interrupted tasks:', error);
    }
};


handleInterruptedTasks()

Bun.serve({
    port: 8080,
    fetch: (request) => {
        return app.handle(request)
    },
    tls: {
        key: fs.readFileSync('/etc/letsencrypt/live/backend.removegreenscreen.com/privkey.pem'),
        cert: fs.readFileSync('/etc/letsencrypt/live/backend.removegreenscreen.com/fullchain.pem')
    },
});