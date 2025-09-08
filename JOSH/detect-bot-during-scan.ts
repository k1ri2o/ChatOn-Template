import { Op } from 'sequelize';
import PostScansFacebook from '!/db/marketing/scans/PostScansFacebook';
import PostScansGram from '!/db/marketing/scans/PostScansGram';
import PostScansSnapchat from '!/db/marketing/scans/PostScansSnapchat';
import PostScansTiktok from '!/db/marketing/scans/PostScansTiktok';
import PostScansTube from '!/db/marketing/scans/PostScansTube';
import PostScansTwitter from '!/db/marketing/scans/PostScansTwitter';
import Submission from '!/db/marketing/Submission';
import SubmissionInfo from '!/db/marketing/SubmissionInfo';
import { detectBotAlgo } from '!/domain/bot-detector/detect-bot-algo';

export async function detectBotDuringScan(submissionId: number): Promise<boolean> {
  const submission = await Submission.findByPk(submissionId, {
    include: [
      {
        model: SubmissionInfo,
        required: false,
      },
    ],
  });

  if (!submission) {
    throw Error('Missing submission');
  }

  let scans;
  const scansWhereOptions = {
    submissionId: submission.id,
    extendedScan: { [Op.not]: true },
  };

  switch (submission.platform) {
    case 'facebook':
      scans = await PostScansFacebook.findAll({
        where: scansWhereOptions,
        order: [['id', 'ASC']],
      });
      break;
    case 'instagram':
      scans = await PostScansGram.findAll({
        where: scansWhereOptions,
        order: [['id', 'ASC']],
      });
      break;
    case 'snapchat':
      scans = await PostScansSnapchat.findAll({
        where: scansWhereOptions,
        order: [['id', 'ASC']],
      });
      break;
    case 'tiktok':
      scans = await PostScansTiktok.findAll({
        where: scansWhereOptions,
        order: [['id', 'ASC']],
      });
      break;
    case 'twitter':
      scans = await PostScansTwitter.findAll({
        where: scansWhereOptions,
        order: [['id', 'ASC']],
      });
      break;
    case 'youtube':
    case 'youtube-short':
      scans = await PostScansTube.findAll({
        where: scansWhereOptions,
        order: [['id', 'ASC']],
      });
      break;
  }

  if (scans.length < 2) {
    return;
  }

  let shouldReject = false;
  let internalNotes = submission.submissionInfo?.internalNotes || '';

  for (let i = 1; i < scans.length; i++) {
    const currentScan = scans[i];
    const prevScan = scans[i - 1];

    const botDetectionResults = detectBotAlgo({
      prevScan: prevScan,
      currentScan: currentScan,
      platform: submission.platform === 'youtube-short' ? 'youtube' : submission.platform,
      scanIndex: i,
      allScans: scans,
    });

    if (botDetectionResults?.bottedReason?.trim()) {
      internalNotes += `${!internalNotes ? '' : '\n\n'} ${new Date().toISOString()} shouldReject: ${botDetectionResults.shouldReject} bottedReason: ${botDetectionResults.bottedReason} between scans ${i} and ${i + 1} `;
    }

    if (botDetectionResults?.shouldReject) {
      shouldReject = true;
    }
  }

  await SubmissionInfo.update(
    {
      internalNotes: internalNotes,
    },
    { where: { submissionId: submission.id } },
  );

  return shouldReject;
}
