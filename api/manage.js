const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { generateCompanyBlurb } = require('./_companyInfo');

const MAX_TAGLINE_LENGTH = 120;
const MAX_BLURB_LENGTH = 400;

// Note on the security model here: possession of the token is the only
// check, same idea as an email "manage your subscription" link. It only
// ever grants control over that one purchase's cosmetic fields (tagline,
// logo, color, AI blurb) -- never the company name or destination URL,
// which stay behind the moderated purchase flow on purpose.

module.exports = async (req, res) => {
  const token = req.method === 'GET' ? req.query.token : (req.body || {}).token;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing edit link token.' });
  }

  if (req.method === 'GET') {
    const { data: squares, error } = await supabase
      .from('squares')
      .select('id, idx, company_name, website_url, tagline, logo_url, color, ai_blurb_fi, ai_blurb_en, ai_blurb_source, status, town_id')
      .eq('edit_token', token)
      .eq('status', 'active');
    if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
    if (!squares || squares.length === 0) {
      return res.status(404).json({ error: 'No active squares found for this link.' });
    }
    const { data: town } = await supabase.from('towns').select('name, slug').eq('id', squares[0].town_id).maybeSingle();
    return res.status(200).json({ squares, town });
  }

  if (req.method === 'POST') {
    const { data: squares, error } = await supabase
      .from('squares')
      .select('id, company_name, website_url')
      .eq('edit_token', token)
      .eq('status', 'active');
    if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
    if (!squares || squares.length === 0) {
      return res.status(404).json({ error: 'No active squares found for this link.' });
    }
    const ids = squares.map(s => s.id);
    const { tagline, logoUrl, color, action, aiBlurbFi, aiBlurbEn } = req.body || {};
    const update = {};

    if (typeof tagline === 'string') {
      if (tagline.length > MAX_TAGLINE_LENGTH) return res.status(400).json({ error: 'Tagline too long.' });
      update.tagline = tagline || null;
    }
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      update.color = color;
    }
    if (typeof logoUrl === 'string') {
      if (logoUrl) {
        const problem = isSuspicious(logoUrl);
        if (problem) return res.status(400).json({ error: `Logo URL: ${problem}` });
      }
      update.logo_url = logoUrl || null;
    }

    if (action === 'clear_blurb') {
      update.ai_blurb_fi = null;
      update.ai_blurb_en = null;
      update.ai_blurb_source = null;
    } else if (action === 'regenerate_blurb') {
      const blurb = await generateCompanyBlurb({
        companyName: squares[0].company_name,
        websiteUrl: squares[0].website_url
      });
      update.ai_blurb_fi = blurb.found ? blurb.fi : null;
      update.ai_blurb_en = blurb.found ? blurb.en : null;
      update.ai_blurb_source = blurb.found ? blurb.source_url : null;
    } else if (typeof aiBlurbFi === 'string' || typeof aiBlurbEn === 'string') {
      if ((aiBlurbFi && aiBlurbFi.length > MAX_BLURB_LENGTH) || (aiBlurbEn && aiBlurbEn.length > MAX_BLURB_LENGTH)) {
        return res.status(400).json({ error: 'Blurb text too long.' });
      }
      if (typeof aiBlurbFi === 'string') update.ai_blurb_fi = aiBlurbFi || null;
      if (typeof aiBlurbEn === 'string') update.ai_blurb_en = aiBlurbEn || null;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error: updateErr } = await supabase.from('squares').update(update).in('id', ids);
    if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Save failed.' }); }
    return res.status(200).json({ ok: true, update });
  }

  res.status(405).end();
};
