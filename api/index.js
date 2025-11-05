import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'nearby_commerce_api', time: new Date().toISOString() });
});

app.get('/reviews', async (req, res) => {
  const { location_id } = req.query;
  let q = supabase.from('reviews').select('*').order('created_at', { ascending: false }).limit(100);
  if (location_id) q = q.eq('location_id', location_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, count: data.length, rows: data });
});

app.post('/reviews', async (req, res) => {
  const b = req.body || {};
  const location_id = b.location_id;
  const rating = Number(b.rating);
  const review_text = b.review_text ?? null;

  if (!location_id || !Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ ok: false, error: 'location_id and rating (1–5) are required' });
  }

  const { data, error } = await supabase
    .from('reviews')
    .insert([{ location_id, rating, review_text }])
    .select('*')
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.status(201).json({ ok: true, row: data });
});

// GET /locations?city=&status=
app.get('/locations', async (req, res) => {
  const { city, status } = req.query;
  let q = supabase.from('locations').select('*').order('id', { ascending: true });
  if (city)   q = q.ilike('city', city);   // e.g. 'Delhi' or '%del%'
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, count: data.length, rows: data });
});

// GET /stats/location/:id
app.get('/stats/location/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('v_location_30d')
    .select('*')
    .eq('location_id', id)
    .single();

  // If no row exists (no reviews in 30d), return zeros instead of 404
  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({
    ok: true,
    location_id: id,
    reviews_30d: data?.reviews_30d ?? 0,
    avg_rating_30d: data?.avg_rating_30d ?? null
  });
});

// GET /stats/brand/:brandId/heatmap?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/stats/brand/:brandId/heatmap', async (req, res) => {
  const { brandId } = req.params;
  const { from, to } = req.query;

  const start = from ? new Date(from).toISOString()
                     : new Date(Date.now() - 30 * 864e5).toISOString();
  const end   = to   ? new Date(to).toISOString()
                     : new Date().toISOString();

  // Join reviews with locations to filter by brand
  const { data, error } = await supabase
    .from('reviews')
    .select('rating, created_at, location_id, locations!inner(city, brand_id)')
    .gte('created_at', start)
    .lte('created_at', end)
    .eq('locations.brand_id', brandId);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Aggregate by city in memory
  const map = new Map();
  for (const r of data) {
    const city = r.locations.city ?? 'Unknown';
    const prev = map.get(city) || { city, reviews: 0, sum: 0 };
    prev.reviews += 1;
    prev.sum     += r.rating;
    map.set(city, prev);
  }

  const rows = [...map.values()].map(x => ({
    city: x.city,
    reviews: x.reviews,
    avg_rating: Number((x.sum / x.reviews).toFixed(2))
  }));

  res.json({ ok: true, rows, window: { from: start, to: end } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API running on http://localhost:${PORT}`));
