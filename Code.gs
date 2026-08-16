/**
 * Student Grade Portal — Read-Only API
 * Google Apps Script Web App
 *
 * This is a SEPARATE, READ-ONLY API for the student-facing portal.
 * It does NOT modify the existing SGMS database in any way.
 * It only reads from the existing Google Sheet to find a student
 * by their QR token and return their grades and activities.
 *
 * ─────────────────────────────────────────────────────────────────
 * REFACTOR NOTES (v1.1.0)
 * ─────────────────────────────────────────────────────────────────
 * 1. QR CODE ECHO
 *    The response now includes `qrToken`, the exact token the student
 *    scanned. The frontend renders it back as a small QR image next
 *    to the student's name — visual confirmation it's their own code.
 *
 * 2. ZERO-WEIGHT TERMS ARE HIDDEN
 *    Any grading term whose WEIGHT_PERCENT is 0 (e.g. an admin sets
 *    "Other Midterm Activities" to 0%) is completely excluded from
 *    `grades.termGrades` AND from the flat `activities` list, so it
 *    never appears anywhere on the student portal. It still has no
 *    effect on the overall grade math (a 0% weight already
 *    contributes 0 to the total), so hiding it is purely cosmetic
 *    and 100% safe.
 *
 * 3. CUMULATIVE STAGE PASSING SCORES
 *    Mirrors the exact "Semester Grade Summary Table" logic used by
 *    the admin PrintService (see sgms_backend/PrintService.gs):
 *
 *      Stage 1 = Midterm Collective (weighted) + Midterm Exam (weighted)
 *      Stage 2 = Stage 1 + Final Collective Initial (weighted)
 *      Stage 3 = Stage 2 + Final Collective Final (weighted)
 *      Stage 4 = Stage 3 + Final Exam (weighted)   → equals the overall
 *                cumulative grade shown on the official report card
 *
 *    Each stage is compared against the admin's STAGE1_PASSING..
 *    STAGE4_PASSING settings (Admin → Settings → Calculations →
 *    "Cumulative Stage Passing Scores"), with the exact same fallback
 *    defaults used by the admin app (40 / 55 / 65 / 50).
 *
 *    Terms are matched to a stage role (Midterm Collective, Midterm
 *    Exam, Final Collective Initial, Final Collective Final, Final
 *    Exam) by name, exactly like PrintService.findTerm() — so this
 *    keeps working even if TERM_IDs differ between deployments.
 *
 * 4. PASS/FAIL "CONTACT YOUR TEACHER" GUIDANCE
 *    The API doesn't hardcode UI copy, but every grade/stage now
 *    carries a clean boolean `passed` flag so the frontend can show
 *    a "please see your teacher" banner whenever the student is
 *    failing the overall grade or any cumulative stage.
 *
 * DEPLOYMENT:
 *   1. Open script.google.com → New Project
 *   2. Paste this entire file
 *   3. Set SPREADSHEET_ID below (from your existing Google Sheet URL)
 *   4. Run `initializePortal` once to verify access
 *   5. Deploy → New Deployment → Web App
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   6. Copy the Web App URL into the frontend config (app.js → API_URL)
 */

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION — Set your existing Google Sheet ID here
// ═══════════════════════════════════════════════════════════════

/**
 * PASTE your existing Google Sheet ID here.
 * The ID is the long string in the middle of your Sheet URL:
 * https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit
 */
var SPREADSHEET_ID = '1wVKx1bGUmn_c3Jh9XuzXEHzi0M7a982iFg44fDAH1Y4';

/**
 * Sheet names — these must match the existing SGMS database exactly.
 * If your sheets are named differently, change them here.
 */
var SHEETS = {
  STUDENTS: 'STUDENTS',
  GRADING_TERMS: 'GRADING_TERMS',
  ACTIVITIES: 'ACTIVITIES',
  SCORES: 'SCORES',
  QR_TOKENS: 'QR_TOKENS',
  SETTINGS: 'SETTINGS'
};

/**
 * Fallback cumulative-stage passing scores. These are only used if the
 * admin's SETTINGS sheet doesn't have the corresponding STAGE#_PASSING
 * key yet — they match the defaults shipped in sgms_backend/Config.gs.
 */
var DEFAULT_STAGE_PASSING = {
  STAGE1_PASSING: 40, // Midterm Collective + Midterm Exam
  STAGE2_PASSING: 55, // + Final Collective Initial
  STAGE3_PASSING: 65, // + Final Collective Final
  STAGE4_PASSING: 50  // + Final Exam (Overall)
};

/**
 * Keyword groups used to match a GRADING_TERMS row to a stage "role",
 * identical in spirit to findTerm() in sgms_backend/PrintService.gs.
 * Matching is case-insensitive substring matching against TERM_NAME.
 */
var TERM_ROLE_KEYWORDS = {
  midColl:     ['midterm collective', 'mid collective', 'midcoll'],
  midExam:     ['midterm exam', 'mid exam', 'midterm examination'],
  finCollInit: ['final collective initial', 'fin coll init', 'final collective i'],
  finCollFin:  ['final collective final', 'fin coll fin', 'final collective f'],
  finExam:     ['final exam', 'fin exam', 'final examination']
};

var STAGE_DEFINITIONS = [
  { key: 'STAGE1_PASSING', name: 'Stage 1', label: 'Midterm Collective + Midterm Exam', roles: ['midColl', 'midExam'] },
  { key: 'STAGE2_PASSING', name: 'Stage 2', label: '+ Final Collective Initial', roles: ['finCollInit'] },
  { key: 'STAGE3_PASSING', name: 'Stage 3', label: '+ Final Collective Final', roles: ['finCollFin'] },
  { key: 'STAGE4_PASSING', name: 'Stage 4', label: '+ Final Exam (Overall)', roles: ['finExam'] }
];

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
        return jsonOut({ success: true, message: 'Student Portal API is running', version: '1.1.0' });
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

    // ── Step 3: Read grading terms, activities, scores, and settings ──
    var termsData = readSheetData(ss, SHEETS.GRADING_TERMS);
    var activitiesData = readSheetData(ss, SHEETS.ACTIVITIES);
    var scoresData = readSheetData(ss, SHEETS.SCORES);
    var settings = readSettingsMap(ss);

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
    // NOTE: ALL terms (including 0%-weight ones) are used for the math,
    // exactly like the admin engine — a 0% term already contributes 0 to
    // the overall grade, so including it here changes nothing numerically.
    // We only strip 0%-weight terms from what gets SENT to the student,
    // in the "visible" arrays built in Step 7 below.
    var termGrades = [];          // full list, used for overall + stage math
    var weightedScoreByTermId = {}; // TERM_ID -> weighted score, for stage calc
    var totalWeightedScore = 0;

    terms.forEach(function(term) {
      var termId = String(term.TERM_ID || '').trim();
      var termWeight = parseFloat(term.WEIGHT_PERCENT) || 0;

      var termActivities = applicableActivities.filter(function(act) {
        return act.TERM_ID === term.TERM_ID &&
               (act.IS_ACTIVE === true || act.IS_ACTIVE === 'TRUE' || act.IS_ACTIVE === 'true');
      });
      termActivities.sort(function(x, y) { return (x.ACTIVITY_ORDER || 0) - (y.ACTIVITY_ORDER || 0); });

      if (termActivities.length === 0) {
        termGrades.push({
          termId: termId,
          termName: term.TERM_NAME,
          weight: term.WEIGHT_PERCENT,
          rawPercentage: 0,
          weightedScore: 0,
          passed: false,
          activities: []
        });
        weightedScoreByTermId[termId] = 0;
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
      var weightedScore = (rawPercentage * termWeight) / 100;
      totalWeightedScore += weightedScore;
      weightedScoreByTermId[termId] = Math.round(weightedScore * 100) / 100;

      var passingPercent = parseFloat(term.PASSING_PERCENT) || 50;

      termGrades.push({
        termId: termId,
        termName: term.TERM_NAME,
        weight: term.WEIGHT_PERCENT,
        rawPercentage: Math.round(rawPercentage * 100) / 100,
        weightedScore: Math.round(weightedScore * 100) / 100,
        passed: rawPercentage >= passingPercent,
        activities: activityDetails
      });
    });

    var overallGrade = Math.round(totalWeightedScore * 100) / 100;
    var overallPassingPercent = parseFloat(settings.OVERALL_PASSING_PERCENT) || 50;
    var overallPassed = overallGrade >= overallPassingPercent;

    // ── Step 6: Cumulative Stage Passing Scores ──
    // Mirrors PrintService's Semester Grade Summary Table exactly.
    var termRoleMap = buildTermRoleMap(terms);
    var cumulativeStages = buildCumulativeStages(termRoleMap, weightedScoreByTermId, settings);

    // ── Step 7: Build the VISIBLE (student-facing) lists ──
    // Requirement: any term with WEIGHT_PERCENT == 0 is fully hidden —
    // both from the term-by-term grade breakdown and from the flat
    // activities list, since its activities "belong" to a hidden section.
    var hiddenTermIds = {};
    terms.forEach(function(term) {
      var w = parseFloat(term.WEIGHT_PERCENT);
      if (!w || w === 0) {
        hiddenTermIds[String(term.TERM_ID || '').trim()] = true;
      }
    });

    var visibleTermGrades = termGrades.filter(function(tg) {
      return !hiddenTermIds[tg.termId];
    });

    var visibleActivities = applicableActivities.filter(function(act) {
      return (act.IS_ACTIVE === true || act.IS_ACTIVE === 'TRUE' || act.IS_ACTIVE === 'true') &&
             !hiddenTermIds[String(act.TERM_ID || '').trim()];
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
    });

    // ── Step 8: Build the response ──
    var response = {
      success: true,
      message: 'Student record found',
      qrToken: token, // same token the student just scanned — rendered back as their QR
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
        termGrades: visibleTermGrades,
        overallGrade: overallGrade,
        overallPassed: overallPassed,
        overallPassingPercent: overallPassingPercent,
        cumulativeStages: cumulativeStages
      },
      activities: visibleActivities
    };

    return jsonOut(response);

  } catch (error) {
    Logger.log('handleGetStudentByToken error: ' + error.toString());
    return jsonOut({ success: false, message: 'Unable to retrieve student record. Please try again later.', data: null });
  }
}

// ═══════════════════════════════════════════════════════════════
//  CUMULATIVE STAGE HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Match each GRADING_TERMS row to a stage "role" (midColl, midExam,
 * finCollInit, finCollFin, finExam) by TERM_NAME keyword, the same way
 * sgms_backend/PrintService.gs's findTerm() does. Returns a map of
 * role -> term object (or null if no matching term exists).
 */
function buildTermRoleMap(terms) {
  var map = {};
  Object.keys(TERM_ROLE_KEYWORDS).forEach(function(role) {
    var keywords = TERM_ROLE_KEYWORDS[role];
    map[role] = terms.find(function(t) {
      var n = String(t.TERM_NAME || '').toLowerCase();
      return keywords.some(function(k) { return n.indexOf(k) !== -1; });
    }) || null;
  });
  return map;
}

/**
 * Build the 4-stage cumulative summary, adding each stage's own
 * weighted-score contribution on top of the running total from the
 * previous stage — identical math to the "Semester Grade Summary
 * Table" (column S) written by PrintService.fillStudentColumns().
 *
 * A stage is only included if ALL of the terms it depends on (this
 * stage's own role(s) AND every stage before it) were found by name.
 * This keeps the portal safe even if a school renamed/removed a term.
 */
function buildCumulativeStages(termRoleMap, weightedScoreByTermId, settings) {
  var stages = [];
  var runningTotal = 0;
  var chainIntact = true;

  STAGE_DEFINITIONS.forEach(function(def) {
    if (!chainIntact) return;

    var stageContribution = 0;
    var rolesFound = def.roles.every(function(role) {
      var term = termRoleMap[role];
      if (!term) return false;
      var termId = String(term.TERM_ID || '').trim();
      stageContribution += weightedScoreByTermId[termId] || 0;
      return true;
    });

    if (!rolesFound) {
      chainIntact = false; // can't compute this stage or any after it
      return;
    }

    runningTotal += stageContribution;
    var cumulativeScore = Math.round(runningTotal * 100) / 100;

    var passingScore = parseFloat(settings[def.key]);
    if (isNaN(passingScore)) {
      passingScore = (def.key === 'STAGE4_PASSING' && settings.OVERALL_PASSING_PERCENT)
        ? (parseFloat(settings.OVERALL_PASSING_PERCENT) || DEFAULT_STAGE_PASSING[def.key])
        : DEFAULT_STAGE_PASSING[def.key];
    }

    stages.push({
      name: def.name,
      label: def.label,
      cumulativeScore: cumulativeScore,
      passingScore: passingScore,
      passed: cumulativeScore >= passingScore
    });
  });

  return stages;
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
 * Read the SETTINGS sheet (SETTING_KEY / SETTING_VALUE columns) into a
 * plain { KEY: 'value' } map. Returns {} if the sheet is missing so the
 * rest of the code can safely fall back to defaults.
 */
function readSettingsMap(ss) {
  var map = {};
  try {
    var data = readSheetData(ss, SHEETS.SETTINGS);
    if (!data) return map;
    var keyIdx = data.headerMap.SETTING_KEY;
    var valIdx = data.headerMap.SETTING_VALUE;
    if (keyIdx === undefined || valIdx === undefined) return map;
    for (var i = 1; i < data.values.length; i++) {
      var key = data.values[i][keyIdx];
      if (key) map[String(key)] = data.values[i][valIdx];
    }
  } catch (e) {
    Logger.log('Error reading settings: ' + e.toString());
  }
  return map;
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