import { debug, error } from '!/boot/logger';
import PostScansFacebook from '!/db/marketing/scans/PostScansFacebook';
import PostScansGram from '!/db/marketing/scans/PostScansGram';
import PostScansSnapchat from '!/db/marketing/scans/PostScansSnapchat';
import PostScansTiktok from '!/db/marketing/scans/PostScansTiktok';
import PostScansTube from '!/db/marketing/scans/PostScansTube';
import PostScansTwitter from '!/db/marketing/scans/PostScansTwitter';
import Submission from '!/db/marketing/Submission';
import SubmissionInfo from '!/db/marketing/SubmissionInfo';
import { BotDetectorAlgoResponse, detectBotAlgo } from '!/domain/bot-detector/detect-bot-algo';
import settingsManager from '!/domain/settings/SettingsManager';
import { ErrorLogType, logErrorToDb } from '!/email/techAlert/logErrorToDb';
import { BotAnalysis } from '!/models/BotAnalysis';
import { formatDateTimeUTC } from '!/util-marketing/format-date-time-utc';
import { numberWithCommas } from '!/util/format';
import { Request, Response } from 'express';
import { Op } from 'sequelize';

export interface DumpMarketingData {
  securityToken: string;
  postUrl: string;
  adminToken?: string;
}

/**
 * POST /admin/dump-data
 */
export const adminDumpMarketingDataHandler = async (req: Request, res: Response<string>): Promise<void> => {
  try {
    debug('-- admin-dump-marketing-data --');

    const { securityToken, postUrl, adminToken } = req.query as unknown as DumpMarketingData;

    if (securityToken !== process.env.ADMIN_SECURITY_TOKEN) {
      res.status(401).send('not authed');
      return;
    }

    const submissions: Submission[] = await Submission.findAll({
      where: {
        [Op.or]: {
          linkSubmitted: postUrl,
          linkCanonical: postUrl,
        },
        duplicateCanonical: false,
      },
      include: [
        {
          model: SubmissionInfo,
          required: false,
        },
      ],
    });

    let html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans'; background: #fff; color: #111827; padding: 16px; }
        h2 { font-size: 16px; margin: 8px 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        thead th { background: #eef2ff; position: sticky; top: 0; z-index: 1; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; min-width: 100px; }
        th:first-child, td:first-child { text-align: left; }
        tbody td:first-child { font-weight: 600; }
        ol { padding-left: 18px; }
      </style>
    </head>
    <body>
    `;

    for (let i = 0; i < submissions.length; i++) {
      const submission = submissions[i];
      const platform = submission.platform;
      const sObject = submission.get({ plain: true });

      html += `<div style="margin-top:16px; padding:12px; border:1px solid #d7d7d7; background:#f4f4f4; border-radius:8px;">`;
      html += `<h2>POSTED TIME @ ${formatDateTimeUTC(submission.datePosted)}</h2>`;
      html += `<h2>SUBMIT TIME @ ${formatDateTimeUTC(submission.createdAt)}</h2>`;
      html += `<h2>LAST&nbsp;&nbsp;&nbsp;SCAN: @ ${formatDateTimeUTC(submission.lastScannedAt)}</h2>`;

      html += `</div><div style="margin-top:16px; padding:12px; border:1px solid #d7d7d7; background:#f4f4f4; border-radius:8px;">`;
      html += `<h2>TOTAL VIEWS: ${numberWithCommas(submission.views)}</h2>`;
      html += `<h2>AT LEAST 7 DAYS SINCE POSTING: ${submission.sevenDays ? 'YES' : 'NO'}</h2>`;
      html += `</div>`;

      let scans = [];
      const showExtendedScans = await settingsManager.settings.show_extended_scans_in_admin_dump;
      const extendedScansCondition = showExtendedScans
        ? {}
        : {
            extendedScan: { [Op.not]: true },
          };
      switch (platform) {
        case 'tiktok':
          scans = await PostScansTiktok.findAll({
            where: {
              submissionId: submission.id,
              ...extendedScansCondition,
            },
            order: [['id', 'ASC']],
          });
          break;
        case 'instagram':
          scans = await PostScansGram.findAll({
            where: {
              submissionId: submission.id,
              ...extendedScansCondition,
            },
            order: [['id', 'ASC']],
          });
          break;
        case 'youtube':
          scans = await PostScansTube.findAll({
            where: {
              submissionId: submission.id,
              ...extendedScansCondition,
            },
            order: [['id', 'ASC']],
          });
          break;
        case 'facebook':
          scans = await PostScansFacebook.findAll({
            where: {
              submissionId: submission.id,
              ...extendedScansCondition,
            },
            order: [['id', 'ASC']],
          });
          break;
        case 'snapchat':
          scans = await PostScansSnapchat.findAll({
            where: {
              submissionId: submission.id,
              ...extendedScansCondition,
            },
            order: [['id', 'ASC']],
          });
          break;
        case 'twitter':
          scans = await PostScansTwitter.findAll({
            where: {
              submissionId: submission.id,
              ...extendedScansCondition,
            },
            order: [['id', 'ASC']],
          });
          break;
      }

      const headers: string[] = [];
      const views: string[] = [];
      const likes: string[] = [];
      const comments: string[] = [];
      const saves: string[] = []; // tiktok only
      const shares: string[] = []; // tiktok only
      const retweets: string[] = []; // twitter only
      const bookmarks: string[] = []; // twitter only
      const quotes: string[] = []; // twitter only

      const likesRatio: string[] = [];
      const commentsRatio: string[] = [];
      const savesRatio: string[] = []; // tiktok only
      const sharesRatio: string[] = []; // tiktok only
      const retweetsRatio: string[] = []; // twitter only
      const bookmarksRatio: string[] = []; // twitter only
      const quotesRatio: string[] = []; // twitter only

      const bottedReason: Map<string, boolean> = new Map();

      for (let index = 1; index < scans.length; index++) {
        const scan = scans[index];
        const prevScan = scans[index - 1];

        const isExtendedScan = scan.extendedScan;
        const style = isExtendedScan ? ' style="background-color: #d8f3dc;"' : '';
        const scanViews = scan.views < 0 ? 0 : scan.views;
        const scanLikes = scan.likes < 0 ? 0 : scan.likes;
        const scanComments = scan.comments < 0 ? 0 : scan.comments;
        const scanShares = scan.shares < 0 ? 0 : scan.shares;
        const scanSaves = scan.saves < 0 ? 0 : scan.saves;
        const scanRetweets = scan.retweets < 0 ? 0 : scan.retweets;
        const scanBookmarks = scan.bookmarks < 0 ? 0 : scan.bookmarks;
        const scanQuotes = scan.quotes < 0 ? 0 : scan.quotes;

        headers.push(`<th${style}>Scan ${index} @ ${formatDateTimeUTC(scan.createdAt)}</th>`);
        views.push(`<td${style}>${numberWithCommas(scanViews)}</td>`);
        likes.push(`<td${style}>${numberWithCommas(scanLikes)}</td>`);
        comments.push(`<td${style}>${numberWithCommas(scanComments)}</td>`);

        if (platform === 'tiktok') {
          saves.push(`<td${style}>${numberWithCommas(scanSaves)}</td>`);
          shares.push(`<td${style}>${numberWithCommas(scanShares)}</td>`);
        }

        if (platform === 'snapchat') {
          shares.push(`<td${style}>${numberWithCommas(scanShares)}</td>`);
        }

        if (platform === 'twitter') {
          retweets.push(`<td${style}>${numberWithCommas(scanRetweets)}</td>`);
          bookmarks.push(`<td${style}>${numberWithCommas(scanBookmarks)}</td>`);
          quotes.push(`<td${style}>${numberWithCommas(scanQuotes)}</td>`);
        }

        const commentRatio = (scanComments / scanViews) * 100;

        const botDetectionReasons: BotDetectorAlgoResponse = detectBotAlgo({
          prevScan,
          currentScan: scan,
          platform: platform === 'youtube-short' ? 'youtube' : platform,
          scanIndex: index,
          allScans: scans,
          logNotes: true,
        });

        if (botDetectionReasons?.bottedReason?.length > 0) {
          bottedReason.set(`#${index}: ${botDetectionReasons?.bottedReason}`, botDetectionReasons.shouldReject);
        }

        likesRatio.push(`<td${style}>${((scanLikes / scanViews) * 100).toFixed(2)}%</td>`);
        commentsRatio.push(`<td${style}>${commentRatio.toFixed(3)}%</td>`);

        if (platform === 'tiktok') {
          savesRatio.push(`<td${style}>${((scanSaves / scanViews) * 100).toFixed(2)}%</td>`);
          sharesRatio.push(`<td${style}>${((scanShares / scanViews) * 100).toFixed(3)}%</td>`);
        }
        if (platform === 'twitter') {
          retweetsRatio.push(`<td${style}>${((scanBookmarks / scanViews) * 100).toFixed(2)}%</td>`);
          bookmarksRatio.push(`<td${style}>${((scanRetweets / scanViews) * 100).toFixed(3)}%</td>`);
          quotesRatio.push(`<td${style}>${((scanQuotes / scanViews) * 100).toFixed(3)}%</td>`);
        }
      }

      // show a basic is botted or not (this is shown even to non-admins)

      const hasBottedReason = bottedReason.size > 0;
      const hasReject = Array.from(bottedReason.values()).some(Boolean);

      const containerBorder = !hasBottedReason ? '#13bc4e' : hasReject ? '#fecaca' : '#fed7aa'; // red-200 vs amber-200
      const containerBg = !hasBottedReason ? '#dcfce7' : hasReject ? '#fee2e2' : '#fff7ed'; // red-100 vs amber-50

      html += `
        <div style="margin-top:16px; padding:12px; border:1px solid ${containerBorder}; background:${containerBg}; border-radius:8px;">
          <div style="font-weight:600; color:#000000; padding-bottom:6px;">Bot AI Detection:</div>
          <div style="font-weight:600; color:${!hasBottedReason ? '#22944a' : hasReject ? '#f60c0c' : '#fd8c09'};">${hasBottedReason ? (hasReject ? 'Botted 🔴' : 'Maybe Botted ⚠️') : 'Not Botted ✅'}</div>
        </div>`;

      // TODO: make it more secure with a real token, and verifying access, instead of it being admin email
      if (adminToken) {
        // Bot algo warnings - formatted
        if (bottedReason.size > 0) {
          const hasReject = Array.from(bottedReason.values()).some(Boolean);
          const botReasonsHtml = Array.from(bottedReason.entries())
            .map(([reason, shouldReject]) => {
              const styles = shouldReject
                ? 'color:#b91c1c; font-weight:600;' // emphasized (red)
                : 'color:#6b7280;'; // deemphasized (gray)
              return `<li style="margin: 4px 0; ${styles}">${reason}</li>`;
            })
            .join('');

          const containerBorder = hasReject ? '#fecaca' : '#fed7aa'; // red-200 vs amber-200
          const containerBg = hasReject ? '#fee2e2' : '#fff7ed'; // red-100 vs amber-50

          html += `
              <div style="margin-top:16px; padding:12px; border:1px solid ${containerBorder}; background:${containerBg}; border-radius:8px;">
                <div style="font-weight:600; color:#000000; margin-bottom:6px;">Admin - Algo Result:</div>
                <div style="margin:0; padding-left:18px;">${botReasonsHtml}</div>
              </div>`;
        }

        // Bot AI response - formatted
        if (submission.submissionInfo?.botDetectorResponse) {
          const r = submission.submissionInfo?.botDetectorResponse as BotAnalysis;
          const isBot = !!r?.is_bot;
          const confBotted = typeof r?.confidence?.botted === 'number' ? (r.confidence.botted * 100).toFixed(2) : '—';
          const confAuth =
            typeof r?.confidence?.authentic === 'number' ? (r.confidence.authentic * 100).toFixed(2) : '—';

          html += `
                <div style="margin-top:16px; padding:12px; border:1px solid ${isBot ? '#fed7aa' : '#bbf7d0'}; background:${isBot ? '#fff7ed' : '#ecfdf5'}; border-radius:8px;">
                  <div style="font-weight:600; color:${isBot ? '#b45309' : '#047857'}; margin-bottom:8px;">Admin - Sean AI Result: ${isBot ? '⚠️' : '✅'}</div>
                  <table style="width:100%; border-collapse:collapse;">
                    <tbody>
                      <tr><td style="text-align:left; padding:4px 8px;">Botted?</td><td style="text-align:right; padding:4px 8px; font-weight:600;">${isBot ? 'Yes' : 'No'}</td></tr>
                      <tr><td style="text-align:left; padding:4px 8px;">Confidence (Botted)</td><td style="text-align:right; padding:4px 8px;">${confBotted}%</td></tr>
                      <tr><td style="text-align:left; padding:4px 8px;">Confidence (Authentic)</td><td style="text-align:right; padding:4px 8px;">${confAuth}%</td></tr>
                    </tbody>
                  </table>
                </div>`;
        }
      }

      html += `
      <table style="margin-top:16px;">
        <thead>
          <tr>
            <th></th>
            ${headers.join(' ')}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>views</td>
            ${views.join(' ')}
          </tr>
          <tr>
            <td>likes</td>
            ${likes.join(' ')}
          </tr>
          <tr>
            <td>comments</td>
            ${comments.join(' ')}
          </tr>
      ${
        platform === 'tiktok'
          ? `<tr>
            <td>saves</td>
            ${saves.join(' ')}
          </tr>
          <tr>
            <td>shares</td>
            ${shares.join(' ')}
          </tr>`
          : ''
      }
      ${
        platform === 'snapchat'
          ? `<tr>
                  <td>shares</td>
                  ${shares.join(' ')}
                </tr>`
          : ''
      }
      ${
        platform === 'twitter'
          ? `<tr>
            <td>retweets</td>
            ${retweets.join(' ')}
          </tr>
          <tr>
            <td>bookmarks</td>
            ${bookmarks.join(' ')}
          </tr>
          <tr>
            <td>quotes</td>
            ${quotes.join(' ')}
          </tr>`
          : ''
      }
          <tr>
            <td>--ratios--</td>
          </tr>
          <tr>
            <td>likes</td>
            ${likesRatio.join(' ')}
          </tr>
          <tr>
            <td>comments</td>
            ${commentsRatio.join(' ')}
          </tr>
      ${
        platform === 'tiktok'
          ? `<tr>
            <td>saves</td>
            ${savesRatio.join(' ')}
          </tr>
          <tr>
            <td>shares</td>
            ${sharesRatio.join(' ')}
          </tr>`
          : ''
      }
      ${
        platform === 'twitter'
          ? `<tr>
            <td>saves</td>
            ${retweetsRatio.join(' ')}
          </tr>
          <tr>
            <td>shares</td>
            ${bookmarksRatio.join(' ')}
          </tr>
          <tr>
            <td>shares</td>
            ${quotesRatio.join(' ')}
          </tr>`
          : ''
      }
        </tbody>
      </table>
      `;
    }

    if (html.length === 0) {
      html += 'nothing found, please double check link';
    }

    html += '</body></html>';

    res.send(html);
  } catch (e) {
    error(e);
    logErrorToDb(
      `adminDumpMarketingDataHandler error: ${e}`,
      `getCampaignsHandler stack: ${e?.stack}`,
      ErrorLogType.error,
    );
    res.status(500).send('error');
  }
};
