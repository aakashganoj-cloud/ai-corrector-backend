const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
const Groq = require('groq-sdk');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const JWT_SECRET = 'deploytemp123';

const app = express();

// MySQL Connection Pool
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'akash12112007',
    database: 'ai',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

pool.getConnection()
    .then(conn => {
        console.log('✅ MySQL Connected Successfully');
        conn.release();
    })
    .catch(err => {
        console.error('❌ MySQL Connection Failed:', err.message);
    });

// Initialize Groq AI
const GROQ_API_KEY = "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";
const groq = new Groq({ apiKey: GROQ_API_KEY });

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.options('*', cors());

const upload = multer({ dest: 'uploads/' });
const OCR_API_KEY = "K89407359288957";

const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

app.use(express.json());
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { teacher_id, name, email, password } = req.body;
        
        // Check if all fields provided
        if (!teacher_id || !name || !email || !password) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        // Check if teacher already exists
        const [existing] = await pool.execute(
            'SELECT * FROM teachers WHERE teacher_id = ? OR email = ?',
            [teacher_id, email]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Teacher ID or email already exists' });
        }
        
        // Hash password (10 = salt rounds)
        const password_hash = await bcrypt.hash(password, 10);
        
        // Insert into database
        const [result] = await pool.execute(
            'INSERT INTO teachers (teacher_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
            [teacher_id, name, email, password_hash]
        );
        
        res.status(201).json({ 
            success: true, 
            message: 'Registered successfully' 
        });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ----- LOGIN ROUTE -----
// POST /api/auth/login - Authenticate teacher
app.post('/api/auth/login', async (req, res) => {
    try {
        const { teacher_id, password } = req.body;
        
        // Find teacher in database
        const [rows] = await pool.execute(
            'SELECT * FROM teachers WHERE teacher_id = ? AND is_active = TRUE',
            [teacher_id]
        );
        
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const teacher = rows[0];
        
        // Compare passwords
        const valid = await bcrypt.compare(password, teacher.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Update last login time
        await pool.execute(
            'UPDATE teachers SET last_login = NOW() WHERE id = ?',
            [teacher.id]
        );
        
        // Create JWT token
        const token = jwt.sign(
            { 
                teacher_id: teacher.teacher_id, 
                name: teacher.name, 
                email: teacher.email 
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({ 
            success: true, 
            token, 
            teacher: { 
                teacher_id: teacher.teacher_id, 
                name: teacher.name, 
                email: teacher.email 
            } 
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ----- AUTH MIDDLEWARE -----
// This function protects routes - verifies JWT token
const authenticateToken = (req, res, next) => {
    // Get token from header: "Bearer <token>"
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    // Verify token
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user; // Attach user info to request
        next(); // Continue to the protected route
    });
};

app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', database: 'connected' });
});

// Save to MySQL
async function saveToMySQL(studentInfo, subject, totalMarks, maxMarks, percentage, grade) {
    try {
        const query = `
            INSERT INTO evaluations 
            (student_name, roll_no, subject, total_marks, max_marks, percentage, grade) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await pool.execute(query, [
            studentInfo.name,
            studentInfo.rollNo,
            subject,
            totalMarks,
            maxMarks,
            percentage,
            grade
        ]);
        console.log('💾 Saved to MySQL, ID:', result.insertId);
        return result.insertId;
    } catch (error) {
        console.error('❌ MySQL Save Error:', error.message);
        return null;
    }
}

// Get all evaluations
app.get('/api/evaluations', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM evaluations ORDER BY evaluated_at DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function extractTextWithOCR(filePath) {
    try {
        const buffer = await fs.readFile(filePath);
        const data = await pdfParse(buffer);
        if (data.text && data.text.trim().length > 20) {
            return data.text;
        }
    } catch (e) {}
    
    try {
        const fileData = await fs.readFile(filePath);
        const base64 = fileData.toString('base64');
        
        const FormData = require('form-data');
        const fetch = require('node-fetch');
        
        const formData = new FormData();
        formData.append('base64Image', 'data:application/pdf;base64,' + base64);
        formData.append('apikey', OCR_API_KEY);
        formData.append('language', 'eng');
        
        const response = await fetch('https://api.ocr.space/parse/image ', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        if (result.ParsedResults && result.ParsedResults[0]) {
            return result.ParsedResults[0].ParsedText;
        }
    } catch (err) {
        console.error('OCR Error:', err.message);
    }
    return '';
}

function extractStudentInfo(text) {
    const cleanText = text.replace(/\s+/g, ' ');
    
    console.log('Extracting info from:', cleanText.substring(0, 200));
    
    // ROLL NUMBER - Match alphanumeric patterns
    let rollNo = "N/A";
    const rollPatterns = [
        /Roll\s*(?:Number|No)?[:\s]+([a-zA-Z0-9]{10,20})/i,  // Letters + digits
        /Roll[:\s]+([a-zA-Z0-9]{10,20})/i,
        /Roll\s*#?\s*([a-zA-Z0-9]{10,20})/i,
        /Student\s*ID[:\s]+([a-zA-Z0-9]{10,20})/i,
        /Enrollment[:\s]+([a-zA-Z0-9]{10,20})/i,
        /Reg(?:istration)?[:\s]+([a-zA-Z0-9]{10,20})/i,
        /R\.?N\.?[:\s]+([a-zA-Z0-9]{10,20})/i,
        // Fallback: find standalone alphanumeric codes that look like roll numbers
        /\b(\d{4}[a-z]{2}\d{8,10})\b/i,  // Pattern: 2511cs03001333
        /\b(\d{4}[a-z]{2}\d{6})\b/i       // Shorter variant
    ];
    
    for (const pattern of rollPatterns) {
        const match = cleanText.match(pattern);
        if (match && match[1].length >= 8) {
            rollNo = match[1].trim();
            console.log('✅ Found roll number:', rollNo);
            break;
        }
    }
    
    // NAME - Look before or after roll number
    let name = "Unknown";
    const namePatterns = [
        /Student\s*Name[:\s]+([A-Za-z\s]{3,40})/i,
        /Name[:\s]+([A-Za-z\s]{3,40})/i,
        /Name\s*of\s*Student[:\s]+([A-Za-z\s]{3,40})/i,
        /([A-Za-z\s]{3,20})[,\s]*Roll/i,  // Name before "Roll"
        /Roll.*[,\s]*([A-Za-z\s]{3,20})[,\s]*\d/i  // Name after roll start
    ];
    
    for (const pattern of namePatterns) {
        const match = cleanText.match(pattern);
        if (match) {
            name = match[1].trim();
            console.log('✅ Found name:', name);
            break;
        }
    }
    
    return { name, rollNo };
}

// Parse questions - supports up to 30 questions
function parseQuestions(text) {
    const questions = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
        const match = line.match(/^(\d+)[\.\)\:]\s*(.+)/);
        if (match) {
            const num = parseInt(match[1]);
            if (num >= 1 && num <= 30) {
                const content = match[2].trim();
                const isMCQ = /^[a-dA-D]$/.test(content) || /^[a-dA-D]\s*$/.test(content);
                
                questions.push({
                    number: num,
                    text: content,
                    isMCQ: isMCQ,
                    answer: isMCQ ? content.toUpperCase().trim() : content
                });
            }
        }
    }
    
    return questions;
}

// AI SEMANTIC EVALUATION - Compares meaning, not keywords
async function evaluateWithAI(modelAnswer, studentAnswer, questionNumber, maxMarks) {
    try {
        const prompt = `
You are an expert teacher evaluating a student's answer by comparing it with the model answer.

QUESTION ${questionNumber}:
MODEL ANSWER: "${modelAnswer}"
STUDENT ANSWER: "${studentAnswer}"

Evaluate based on:
1. Semantic similarity - Does the student answer convey the SAME MEANING as the model answer, even if using different words?
2. Key concepts covered - Are the main ideas present?
3. Accuracy - Is the information correct?
4. Completeness - How much of the model answer is covered?

Max Marks: ${marks}

Return ONLY this JSON format:
{
    "marks": (number 0-${maxMarks}),
    "feedback": "(explain why: mention if same meaning but different words, or missing concepts, etc)",
    "similarity": "(High/Medium/Low - semantic similarity level)"
}

Be generous if the meaning is correct even with different wording.`;

        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "You are an expert academic evaluator. Focus on semantic meaning, not exact word matching. Return only valid JSON."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            model: "mixtral-8x7b-32768",
            temperature: 0.2, // Lower temperature for consistent evaluation
            max_tokens: 400
        });

        const aiResponse = completion.choices[0]?.message?.content || '';
        
        // Extract JSON
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            return {
                marks: Math.min(Math.max(parseInt(result.marks) || 0, 0), maxMarks),
                feedback: result.feedback || "Evaluated by AI",
                similarity: result.similarity || "Unknown",
                maxMarks: maxMarks
            };
        }
        
        throw new Error('Invalid AI response format');
        
    } catch (error) {
        console.error(`AI Evaluation Error Q${questionNumber}:`, error.message);
        // Fallback to basic semantic similarity
        return fallbackSemanticEvaluation(modelAnswer, studentAnswer, maxMarks);
    }
}

// Fallback: Basic semantic similarity using word overlap
function fallbackSemanticEvaluation(model, student, maxMarks) {
    const modelWords = model.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const studentWords = student.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    
    // Remove common stop words
    const stopWords = ['the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but', 'his', 'from', 'they', 'she', 'her', 'been'];
    const cleanModel = modelWords.filter(w => !stopWords.includes(w));
    const cleanStudent = studentWords.filter(w => !stopWords.includes(w));
    
    let matches = 0;
    for (const word of cleanStudent) {
        if (cleanModel.some(m => m.includes(word) || word.includes(m))) matches++;
    }
    
    const similarity = cleanModel.length > 0 ? matches / cleanModel.length : 0;
    let marks = 0;
    let feedback = "";
    
    if (similarity >= 0.7) {
        marks = maxMarks;
        feedback = "Excellent - Same meaning conveyed with different words";
    } else if (similarity >= 0.5) {
        marks = Math.floor(maxMarks * 0.8);
        feedback = "Good - Most concepts covered, some differences in wording";
    } else if (similarity >= 0.3) {
        marks = Math.floor(maxMarks * 0.5);
        feedback = "Average - Some concepts missing or different meaning";
    } else {
        marks = Math.floor(maxMarks * 0.2);
        feedback = "Poor - Significant differences from model answer";
    }
    
    return {
        marks: marks,
        feedback: feedback,
        similarity: similarity >= 0.7 ? "High" : similarity >= 0.4 ? "Medium" : "Low",
        maxMarks: maxMarks
    };
}

// MCQ evaluation - exact match
function evaluateMCQ(modelQ, studentQ) {
    const correct = modelQ.answer.toUpperCase();
    const given = studentQ ? studentQ.answer.toUpperCase() : '-';
    const isCorrect = correct === given;
    
    return {
        marks: isCorrect ? 1 : 0,
        maxMarks: 1,
        feedback: isCorrect ? "Correct answer" : `Wrong. Correct: ${correct}, Given: ${given}`,
        studentAnswer: given,
        correctAnswer: correct
    };
}

// Main evaluation endpoint
app.post('/api/evaluate',authenticateToken, upload.fields([
    { name: 'student', maxCount: 1 },
    { name: 'model', maxCount: 1 }
]), async (req, res) => {
    console.log('\n=== AI EVALUATION STARTED ===');
    
    try {
        if (!req.files?.student?.[0]) {
            return res.status(400).json({ error: 'Student PDF required' });
        }

        const studentPath = req.files.student[0].path;
        let studentText = await extractTextWithOCR(studentPath);
        console.log('Student text length:', studentText.length);
        
        let modelText = '';
        if (req.files?.model?.[0]) {
            modelText = await extractTextWithOCR(req.files.model[0].path);
            console.log('Model text length:', modelText.length);
        } else {
            return res.status(400).json({ error: 'Model answer PDF required' });
        }
        
        if (!studentText.trim() || !modelText.trim()) {
            await fs.unlink(studentPath).catch(() => {});
            if (req.files?.model?.[0]) await fs.unlink(req.files.model[0].path).catch(() => {});
            
            return res.json({
                studentInfo: { name: "Unknown", rollNo: "N/A" },
                questions: [{ number: 1, marks: 0, maxMarks: 10, feedback: "Could not read PDF" }],
                totalMarks: 0, maxMarks: 10, percentage: 0, grade: "F",
                overallFeedback: "PDF extraction failed"
            });
        }

        const studentInfo = extractStudentInfo(studentText);
        console.log('Student:', studentInfo);
        
        const modelQuestions = parseQuestions(modelText);
        const studentQuestions = parseQuestions(studentText);
        
        console.log(`Found ${modelQuestions.length} model questions, ${studentQuestions.length} student answers`);
        
        const studentLookup = {};
        for (const q of studentQuestions) {
            studentLookup[q.number] = q;
        }
        
        const evaluatedQuestions = [];
        let totalMarks = 0;
        let totalMax = 0;
        
        // Evaluate each question
        for (const modelQ of modelQuestions) {
            const studentQ = studentLookup[modelQ.number];
            let result;
            
            if (modelQ.isMCQ) {
                // MCQ - exact match
                result = evaluateMCQ(modelQ, studentQ);
            } else {
                // Essay - AI semantic evaluation
                const studentAnswerText = studentQ ? studentQ.text : "No answer provided";
                result = await evaluateWithAI(
                    modelQ.text,
                    studentAnswerText,
                    modelQ.number,
                    5 // max marks for essay
                );
            }
            
            evaluatedQuestions.push({
                number: modelQ.number,
                marks: result.marks,
                maxMarks: result.maxMarks,
                feedback: result.feedback,
                studentAnswer: studentQ ? studentQ.text.substring(0, 100) : "Not answered",
                correctAnswer: modelQ.text.substring(0, 100)
            });
            
            totalMarks += result.marks;
            totalMax += result.maxMarks;
            
            // Rate limiting for AI calls
            if (!modelQ.isMCQ) await new Promise(r => setTimeout(r, 600));
        }
        
        const percentage = totalMax > 0 ? Math.round((totalMarks / totalMax) * 100) : 0;
        const grade = percentage >= 90 ? 'A' : percentage >= 80 ? 'B' : percentage >= 70 ? 'C' : percentage >= 60 ? 'D' : percentage >= 40 ? 'E' : 'F';
        
        const evaluation = {
            studentInfo,
            questions: evaluatedQuestions,
            totalMarks,
            maxMarks: totalMax,
            percentage,
            grade: grade,
            overallFeedback: `AI Evaluated ${evaluatedQuestions.length} questions. Total: ${totalMarks}/${totalMax}`
        };

        // Save to MySQL
        const subjectName = req.body.subject || 'General';
        const mysqlId = await saveToMySQL(
            studentInfo,
            subjectName,
            totalMarks,
            totalMax,
            percentage,
            grade
        );
        
        evaluation.mysqlId = mysqlId;

        console.log('AI Evaluation Result:', evaluation);
        res.json(evaluation);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        try {
            if (req.files?.student?.[0]) await fs.unlink(req.files.student[0].path).catch(() => {});
            if (req.files?.model?.[0]) await fs.unlink(req.files.model[0].path).catch(() => {});
        } catch (e) {}
        console.log('=== DONE ===\n');
    }
});

app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Server error' });
});

const AdmZip = require('adm-zip');
const { createWriteStream } = require('fs');
const archiver = require('archiver');

// WebSocket for progress tracking (optional - can use SSE as fallback)
const WebSocket = require('ws');
const http = require('http');
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/bulk-progress' });

// Store active bulk operations
const activeOperations = new Map();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('WebSocket client connected for bulk progress');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.operationId) {
                ws.operationId = data.operationId;
                activeOperations.set(data.operationId, ws);
            }
        } catch (e) {
            console.error('WebSocket message error:', e);
        }
    });
    
    ws.on('close', () => {
        if (ws.operationId) {
            activeOperations.delete(ws.operationId);
        }
    });
});

// Helper: Send progress update
function sendProgress(operationId, data) {
    const ws = activeOperations.get(operationId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// Helper: Extract ZIP file
async function extractZip(zipPath, extractDir) {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    
    // Find all PDFs in extracted directory
    const files = [];
    async function scanDir(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await scanDir(fullPath);
            } else if (entry.name.toLowerCase().endsWith('.pdf')) {
                files.push(fullPath);
            }
        }
    }
    await scanDir(extractDir);
    return files;
}

// Helper: Process single paper (reuses your existing logic)
async function processSinglePaper(studentPath, modelPath, subject, operationId, current, total) {
    try {
        // Send progress
        sendProgress(operationId, {
            type: 'progress',
            current,
            total,
            filename: path.basename(studentPath),
            status: 'processing'
        });

        const studentText = await extractTextWithOCR(studentPath);
        const modelText = await extractTextWithOCR(modelPath);
        
        if (!studentText.trim()) {
            throw new Error('Could not extract text from PDF');
        }

        const studentInfo = extractStudentInfo(studentText);
        const modelQuestions = parseQuestions(modelText);
        const studentQuestions = parseQuestions(studentText);
        
        const studentLookup = {};
        for (const q of studentQuestions) {
            studentLookup[q.number] = q;
        }
        
        const evaluatedQuestions = [];
        let totalMarks = 0;
        let totalMax = 0;
        
        for (const modelQ of modelQuestions) {
            const studentQ = studentLookup[modelQ.number];
            let result;
            
            if (modelQ.isMCQ) {
                result = evaluateMCQ(modelQ, studentQ);
            } else {
                const studentAnswerText = studentQ ? studentQ.text : "No answer provided";
                result = await evaluateWithAI(
                    modelQ.text,
                    studentAnswerText,
                    modelQ.number,
                    5
                );
            }
            
            evaluatedQuestions.push({
                number: modelQ.number,
                marks: result.marks,
                maxMarks: result.maxMarks,
                feedback: result.feedback
            });
            
            totalMarks += result.marks;
            totalMax += result.maxMarks;
            
            if (!modelQ.isMCQ) await new Promise(r => setTimeout(r, 600));
        }
        
        const percentage = totalMax > 0 ? Math.round((totalMarks / totalMax) * 100) : 0;
        const grade = percentage >= 90 ? 'A' : percentage >= 80 ? 'B' : percentage >= 70 ? 'C' : percentage >= 60 ? 'D' : percentage >= 40 ? 'E' : 'F';
        
        // Save to MySQL
        const mysqlId = await saveToMySQL(
            studentInfo,
            subject,
            totalMarks,
            totalMax,
            percentage,
            grade
        );
        
        // Send success progress
        sendProgress(operationId, {
            type: 'progress',
            current,
            total,
            filename: path.basename(studentPath),
            status: 'completed'
        });
        
        return {
            success: true,
            fileName: path.basename(studentPath),
            studentInfo,
            marks: totalMarks,
            maxMarks: totalMax,
            percentage,
            grade,
            mysqlId,
            questions: evaluatedQuestions,
            feedback: `Evaluated ${evaluatedQuestions.length} questions`
        };
        
    } catch (error) {
        sendProgress(operationId, {
            type: 'error',
            filename: path.basename(studentPath),
            error: error.message
        });
        
        return {
            success: false,
            fileName: path.basename(studentPath),
            error: error.message
        };
    }
}

// BULK EVALUATION ENDPOINT
app.post('/api/bulk-evaluate', authenticateToken, upload.fields([
    { name: 'papers', maxCount: 50 },
    { name: 'zipFile', maxCount: 1 },
    { name: 'model', maxCount: 1 }
]), async (req, res) => {
    const operationId = Date.now().toString();
    const subject = req.body.subject || 'General';
    
    console.log('\n=== BULK EVALUATION STARTED ===');
    console.log('Operation ID:', operationId);
    
    try {
        let studentFiles = [];
        let tempExtractDir = null;
        
        // Handle ZIP upload
        if (req.files?.zipFile?.[0]) {
            const zipPath = req.files.zipFile[0].path;
            tempExtractDir = path.join('uploads', `extracted_${operationId}`);
            await fs.mkdir(tempExtractDir, { recursive: true });
            studentFiles = await extractZip(zipPath, tempExtractDir);
            console.log(`Extracted ${studentFiles.length} PDFs from ZIP`);
        } 
        // Handle multiple individual files
        else if (req.files?.papers) {
            studentFiles = req.files.papers.map(f => f.path);
            console.log(`Received ${studentFiles.length} individual PDFs`);
        }
        
        if (studentFiles.length === 0) {
            return res.status(400).json({ error: 'No PDF files found' });
        }
        
        if (!req.files?.model?.[0]) {
            return res.status(400).json({ error: 'Model answer PDF required' });
        }
        
        const modelPath = req.files.model[0].path;
        const results = [];
        
        // Process each file sequentially (to avoid rate limits)
        for (let i = 0; i < studentFiles.length; i++) {
            const result = await processSinglePaper(
                studentFiles[i],
                modelPath,
                subject,
                operationId,
                i + 1,
                studentFiles.length
            );
            results.push(result);
        }
        
        // Cleanup temp directory if created
        if (tempExtractDir) {
            await fs.rm(tempExtractDir, { recursive: true, force: true }).catch(() => {});
        }
        
        // Cleanup uploaded files
        if (req.files?.zipFile?.[0]) {
            await fs.unlink(req.files.zipFile[0].path).catch(() => {});
        }
        if (req.files?.papers) {
            for (const file of req.files.papers) {
                await fs.unlink(file.path).catch(() => {});
            }
        }
        await fs.unlink(modelPath).catch(() => {});
        
        const successCount = results.filter(r => r.success).length;
        
        console.log(`Bulk evaluation complete: ${successCount}/${results.length} successful`);
        
        res.json({
            success: true,
            operationId,
            totalFiles: results.length,
            successful: successCount,
            failed: results.length - successCount,
            results
        });
        
    } catch (error) {
        console.error('Bulk evaluation error:', error);
        res.status(500).json({ error: error.message });
    }
    
    console.log('=== BULK DONE ===\n');
});

// BULK EXPORT TO EXCEL
app.post('/api/bulk-export', authenticateToken, async (req, res) => {
    try {
        const { results } = req.body;
        
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({ error: 'Results array required' });
        }
        
        const XLSX = require('xlsx');
        
        // Prepare data for Excel
        const data = results.map((r, idx) => ({
            'S.No': idx + 1,
            'File Name': r.fileName,
            'Status': r.success ? 'Success' : 'Failed',
            'Student Name': r.studentInfo?.name || 'N/A',
            'Roll Number': r.studentInfo?.rollNo || 'N/A',
            'Subject': req.body.subject || 'General',
            'Marks': r.success ? r.marks : 'N/A',
            'Max Marks': r.success ? r.maxMarks : 'N/A',
            'Percentage': r.success ? r.percentage + '%' : 'N/A',
            'Grade': r.success ? r.grade : 'N/A',
            'Error': r.success ? '' : (r.error || 'Unknown error')
        }));
        
        const ws = XLSX.utils.json_to_sheet(data);
        
        // Set column widths
        ws['!cols'] = [
            { wch: 5 }, { wch: 30 }, { wch: 10 }, { wch: 20 },
            { wch: 15 }, { wch: 15 }, { wch: 10 }, { wch: 10 },
            { wch: 12 }, { wch: 8 }, { wch: 30 }
        ];
        
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Bulk Results");
        
        // Add summary sheet
        const successCount = results.filter(r => r.success).length;
        const avgScore = results.filter(r => r.success).reduce((sum, r) => sum + (r.percentage || 0), 0) / (successCount || 1);
        
        const summaryData = [
            ['Bulk Evaluation Summary'],
            [''],
            ['Generated:', new Date().toLocaleString()],
            ['Subject:', req.body.subject || 'General'],
            ['Total Files:', results.length],
            ['Successful:', successCount],
            ['Failed:', results.length - successCount],
            ['Success Rate:', Math.round((successCount / results.length) * 100) + '%'],
            ['Average Score:', Math.round(avgScore) + '%']
        ];
        
        const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
        XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");
        
        // Generate buffer
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=bulk_evaluation_${Date.now()}.xlsx`);
        res.send(buffer);
        
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET EVALUATIONS BY SUBJECT (for corrected papers page)
app.get('/api/evaluations/:subject', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM evaluations WHERE subject = ? ORDER BY evaluated_at DESC',
            [req.params.subject]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


server.listen(3000, '0.0.0.0', () => {
    console.log('\n🚀 Server: http://127.0.0.1:3000');
    console.log('🤖 AI Evaluation: Semantic comparison (meaning-based)');
    console.log('📦 Bulk Operations: ZIP + Multi-file support');
    console.log('🔌 WebSocket: /ws/bulk-progress');
    console.log('✅ Supports: Up to 30 Questions');
    console.log('💾 MySQL: Auto-saving results\n');
});