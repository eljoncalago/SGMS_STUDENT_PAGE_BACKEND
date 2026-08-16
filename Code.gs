/**
 * Student Grade Portal — Read-Only API
 * Google Apps Script Web App
 *
 * This is a SEPARATE, READ-ONLY API for the student-facing portal.
 * It does NOT modify the existing SGMS database in any way.
 * It only reads from the existing Google Sheet to find a student
 * by their QR token and return their grades and activities.
 *
 * DEPLOYMENT:
 *   1. Open script.google.com → New Project
 *   2. Paste this entire file
 *   3. Set SPREADSHEET_ID below (from your existing Google Sheet URL)
 *   4. Run `initializePortal` once to verify access
 *   5. Deploy → New Deployment → Web App
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   6. Copy the Web App URL into the frontend config
 */

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION — Set your existing Google Sheet ID here
// ═══════════════════════════════════════════════════════════════

/**
 * PASTE your existing Google Sheet ID here.
 * The ID is the long string in the middle of your Sheet URL:
 * https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit
 */
var SPREADSHEET_ID = 'PASTE_YOUR_SPREADSHEET_ID_HERE';

/**
 * Sheet names — these must match the existing SGMS database exactly.
 * If your sheets are named differently, change them here.
 */
var SHEETS = {
  STUDENTS: 'STUDENTS',
  GRADING_TERMS: 'GRADING_TERMS',
  ACTIVITIES: 'ACTIVITIES',
  SCORES: 'SCORES',
  QR_TOKENS: 'QR_TOKENS'
};

// ═══════════════════════════════════════════════════════════════
//  HTTP HANDLERS
// ═══════════════════════════════════════════════════════════════

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    var params = (e && e.parameter) || {};
    var postData = {};
    if (e && e.postData && e.postData.contents) {
      try {
        postData = JSON.parse(e.postData.contents);
      } catch (err) {
        postData = {};
      }
    }

    var action = postData.action || params.action;
    var payload = postData.payload || params.payload || {};

    if (payload && typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (err) { payload = {}; }
    }

    switch (action) {
      case 'health':
        return jsonOut({ success: true, message: 'Student Portal API is running', version: '1.0.0' });
      case 'getStudentByToken':
        return handleGetStudentByToken(payload);
      default:
        return jsonOut({ success: false, message: 'Unknown action: ' + action, data: null });
    }
  } catch (error) {
    Logger.log('handleRequest error: ' + error.toString());
    return jsonOut({ success: false, message: 'Server error: ' + error.toString(), data: null });
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN API — getStudentByToken
// ═══════════════════════════════════════════════════════════════

/**
 * Given a QR token (the 12-char string encoded in the student's QR code),
 * find the matching student and return their grades + activities.
 *
 * This function is 100% READ-ONLY. It never calls setValues, appendRow,
 * deleteRow, or any mutation method on the spreadsheet.
 */
function handleGetStudentByToken(payload) {
  try {
    var token = payload && payload.token ? String(payload.token).trim().toUpperCase() : '';

    if (!token) {
      return jsonOut({ success: false, message: 'Token is required', data: null });
    }

    var ss = getDatabase();
    if (!ss) {
      return jsonOut({ success: false, message: 'Database unavailable', data: null });
    }

    // ── Step 1: Look up the token in QR_TOKENS ──
    var qrData = readSheetData(ss, SHEETS.QR_TOKENS);
    if (!qrData) {
      return jsonOut({ success: false, message: 'QR token database unavailable', data: null });
    }

    var tokenRow = null;
    for (var i = 1; i < qrData.values.length; i++) {
      var rowToken = String(qrData.values[i][qrData.headerMap.TOKEN] || '').trim().toUpperCase();
      var rowActive = qrData.values[i][qrData.headerMap.IS_ACTIVE];
      if (rowToken === token && (rowActive === true || rowActive === 'TRUE' || rowActive === 'true')) {
        tokenRow = qrData.values[i];
        break;
      }
    }

    if (!tokenRow) {
      return jsonOut({ success: false, message: 'Invalid or inactive QR code. Please see your teacher to get a valid QR code.', data: null });
    }

    var studentId = String(tokenRow[qrData.headerMap.STUDENT_ID] || '').trim();
    if (!studentId) {
      return jsonOut({ success: false, message: 'QR code is not linked to any student', data: null });
    }

    // ── Step 2: Find the student record ──
    var studentData = readSheetData(ss, SHEETS.STUDENTS);
    if (!studentData) {
      return jsonOut({ success: false, message: 'Student database unavailable', data: null });
    }

    var studentRow = null;
    for (var j = 1; j < studentData.values.length; j++) {
      var rowId = String(studentData.values[j][studentData.headerMap.STUDENT_ID] || '').trim();
      if (rowId === studentId) {
        studentRow = studentData.values[j];
        break;
      }
    }

    if (!studentRow) {
      return jsonOut({ success: false, message: 'Student record not found', data: null });
    }

    var student = rowToObject(studentRow, studentData.headers);

    // ── Step 3: Read grading terms, activities, and scores in batch ──
    var termsData = readSheetData(ss, SHEETS.GRADING_TERMS);
    var activitiesData = readSheetData(ss, SHEETS.ACTIVITIES);
    var scoresData = readSheetData(ss, SHEETS.SCORES);

    // Build term list (sorted by TERM_ORDER)
    var terms = [];
    if (termsData) {
      for (var t = 1; t < termsData.values.length; t++) {
        terms.push(rowToObject(termsData.values[t], termsData.headers));
      }
      terms.sort(function(a, b) {
        return (a.TERM_ORDER || 0) - (b.TERM_ORDER || 0);
      });
    }

    // Build activities list
    var allActivities = [];
    if (activitiesData) {
      for (var a = 1; a < activitiesData.values.length; a++) {
        allActivities.push(rowToObject(activitiesData.values[a], activitiesData.headers));
      }
    }

    // Build scores list for THIS student only
    var studentScores = [];
    if (scoresData) {
      for (var s = 1; s < scoresData.values.length; s++) {
        var scoreRow = scoresData.values[s];
        var scoreStudentId = String(scoreRow[scoresData.headerMap.STUDENT_ID] || '').trim();
        if (scoreStudentId === studentId) {
          studentScores.push(rowToObject(scoreRow, scoresData.headers));
        }
      }
    }

    // ── Step 4: Filter activities by student's grade level ──
    var studentGradeLevel = String(student.GRADE_LEVEL || '').trim();
    var applicableActivities = allActivities.filter(function(act) {
      var actGrade = String(act.GRADE_LEVEL || '').trim();
      if (actGrade === '') return true; // shared across all grades
      return actGrade === studentGradeLevel;
    });

    // ── Step 5: Calculate grades per term ──
    var termGrades = [];
    var totalWeightedScore = 0;

    terms.forEach(function(term) {
      var termActivities = applicableActivities.filter(function(act) {
        return act.TERM_ID === term.TERM_ID &&
               (act.IS_ACTIVE === true || act.IS_ACTIVE === 'TRUE' || act.IS_ACTIVE === 'true');
      });

      if (termActivities.length === 0) {
        termGrades.push({
          termName: term.TERM_NAME,
          weight: term.WEIGHT_PERCENT,
          rawPercentage: 0,
          weightedScore: 0,
          passed: false,
          activities: []
        });
        return;
      }

      var totalMaxScore = 0;
      var totalRawScore = 0;
      var activityDetails = [];

      termActivities.forEach(function(activity) {
        var score = studentScores.find(function(sc) {
          return sc.ACTIVITY_ID === activity.ACTIVITY_ID;
        });

        var maxScore = parseFloat(activity.MAX_SCORE) || 0;
        var rawScore = score ? (parseFloat(score.RAW_SCORE) || 0) : 0;

        totalMaxScore += maxScore;
        totalRawScore += rawScore;

        activityDetails.push({
          activityName: activity.ACTIVITY_NAME,
          activityType: activity.ACTIVITY_TYPE || 'General',
          maxScore: maxScore,
          rawScore: rawScore,
          hasScore: !!score
        });
      });

      var rawPercentage = totalMaxScore > 0 ? (totalRawScore / totalMaxScore) * 100 : 0;
      var weightedScore = (rawPercentage * (parseFloat(term.WEIGHT_PERCENT) || 0)) / 100;
      totalWeightedScore += weightedScore;

      var passingPercent = parseFloat(term.PASSING_PERCENT) || 50;

      termGrades.push({
        termName: term.TERM_NAME,
        weight: term.WEIGHT_PERCENT,
        rawPercentage: Math.round(rawPercentage * 100) / 100,
        weightedScore: Math.round(weightedScore * 100) / 100,
        passed: rawPercentage >= passingPercent,
        activities: activityDetails
      });
    });

    var overallGrade = Math.round(totalWeightedScore * 100) / 100;
    var overallPassingPercent = 50;

    // Try to read passing percent from settings
    try {
      var settingsSheet = ss.getSheetByName('SETTINGS');
      if (settingsSheet) {
        var settingsValues = settingsSheet.getDataRange().getValues();
        for (var si = 1; si < settingsValues.length; si++) {
          if (String(settingsValues[si][0]) === 'OVERALL_PASSING_PERCENT') {
            overallPassingPercent = parseFloat(settingsValues[si][1]) || 50;
            break;
          }
        }
      }
    } catch (e) {
      // Use default 50
    }

    // ── Step 6: Build the response ──
    var response = {
      success: true,
      message: 'Student record found',
      student: {
        studentId: student.STUDENT_ID,
        englishName: student.ENGLISH_NAME || '',
        thaiName: student.THAI_NAME || '',
        gradeLevel: student.GRADE_LEVEL || '',
        sectionNumber: student.SECTION_NUMBER || '',
        classNumber: student.CLASS_NUMBER || '',
        status: student.STATUS || ''
      },
      grades: {
        termGrades: termGrades,
        overallGrade: overallGrade,
        overallPassed: overallGrade >= overallPassingPercent,
        overallPassingPercent: overallPassingPercent
      },
      activities: applicableActivities.filter(function(act) {
        return act.IS_ACTIVE === true || act.IS_ACTIVE === 'TRUE' || act.IS_ACTIVE === 'true';
      }).map(function(act) {
        var score = studentScores.find(function(sc) {
          return sc.ACTIVITY_ID === act.ACTIVITY_ID;
        });
        return {
          activityName: act.ACTIVITY_NAME,
          activityType: act.ACTIVITY_TYPE || 'General',
          maxScore: parseFloat(act.MAX_SCORE) || 0,
          rawScore: score ? (parseFloat(score.RAW_SCORE) || 0) : null,
          hasScore: !!score
        };
      })
    };

    return jsonOut(response);

  } catch (error) {
    Logger.log('handleGetStudentByToken error: ' + error.toString());
    return jsonOut({ success: false, message: 'Unable to retrieve student record. Please try again later.', data: null });
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — All read-only
// ═══════════════════════════════════════════════════════════════

/**
 * Get the spreadsheet by ID. Returns null if unavailable.
 */
function getDatabase() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === 'PASTE_YOUR_SPREADSHEET_ID_HERE') {
    Logger.log('ERROR: SPREADSHEET_ID is not set. Edit Code.gs and paste your Google Sheet ID.');
    return null;
  }
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    Logger.log('Cannot open spreadsheet: ' + e.toString());
    return null;
  }
}

/**
 * Read a sheet's data in a single batch operation.
 * Returns { headers, values, headerMap } or null if sheet doesn't exist.
 *
 * This uses getDataRange().getValues() — ONE API call per sheet.
 * No per-row getValue() calls, which would be slow and hit quotas.
 */
function readSheetData(ss, sheetName) {
  try {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log('Sheet not found: ' + sheetName);
      return null;
    }
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return { headers: data[0] || [], values: data, headerMap: {} };
    }
    var headers = data[0];
    var headerMap = {};
    for (var h = 0; h < headers.length; h++) {
      headerMap[headers[h]] = h;
    }
    return { headers: headers, values: data, headerMap: headerMap };
  } catch (e) {
    Logger.log('Error reading sheet ' + sheetName + ': ' + e.toString());
    return null;
  }
}

/**
 * Convert a row array + headers into an object.
 */
function rowToObject(row, headers) {
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    obj[headers[i]] = row[i];
  }
  return obj;
}

/**
 * Create a JSON response.
 */
function jsonOut(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  SETUP / TESTING
// ═══════════════════════════════════════════════════════════════

/**
 * Run this once after pasting your SPREADSHEET_ID to verify
 * the script can access your existing Google Sheet.
 * Check View → Execution Log for results.
 */
function initializePortal() {
  var ss = getDatabase();
  if (!ss) {
    Logger.log('FAILED: Cannot access spreadsheet. Check the SPREADSHEET_ID.');
    return;
  }
  Logger.log('SUCCESS: Connected to spreadsheet: ' + ss.getName());

  var sheetNames = Object.keys(SHEETS);
  sheetNames.forEach(function(key) {
    var sheet = ss.getSheetByName(SHEETS[key]);
    if (sheet) {
      var rowCount = sheet.getLastRow();
      Logger.log('  Sheet "' + SHEETS[key] + '": ' + rowCount + ' rows (including header)');
    } else {
      Logger.log('  Sheet "' + SHEETS[key] + '": NOT FOUND');
    }
  });

  Logger.log('Portal is ready to deploy.');
}

/**
 * Run this to get the Web App URL after deploying.
 */
function getWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  Logger.log('Web App URL: ' + url);
  return url;
}
