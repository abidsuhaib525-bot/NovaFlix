import os
import sys
import base64
import urllib.request
import subprocess
from PIL import Image

def get_base64_image(url, local_path):
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    if not os.path.exists(local_path) or os.path.getsize(local_path) == 0:
        print(f"Downloading {url} to {local_path}...")
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp, open(local_path, 'wb') as f:
            f.write(resp.read())
    
    with open(local_path, 'rb') as f:
        data = f.read()
    ext = 'jpeg' if local_path.endswith('.jpg') else 'png'
    return f"data:image/{ext};base64,{base64.b64encode(data).decode('utf-8')}"

def main():
    cache_dir = os.path.abspath('scripts/cache')
    os.makedirs(cache_dir, exist_ok=True)

    oppenheimer_url = "https://image.tmdb.org/t/p/w780/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"
    dune_url = "https://image.tmdb.org/t/p/w780/6izwz7rsy95ARzTR3poZ8H6c5pp.jpg"
    spiderman_url = "https://image.tmdb.org/t/p/w780/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg"
    backdrop_url = "https://image.tmdb.org/t/p/w1280/8sNiAPPYU14PUepFNeSNGUTiHW.jpg"

    oppenheimer_b64 = get_base64_image(oppenheimer_url, os.path.join(cache_dir, 'oppenheimer.jpg'))
    dune_b64 = get_base64_image(dune_url, os.path.join(cache_dir, 'dune.jpg'))
    spiderman_b64 = get_base64_image(spiderman_url, os.path.join(cache_dir, 'spiderman.jpg'))
    backdrop_b64 = get_base64_image(backdrop_url, os.path.join(cache_dir, 'backdrop.jpg'))

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}

    body {{
      width: 1200px;
      height: 630px;
      overflow: hidden;
      background-color: #06070a;
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      color: #ffffff;
      display: flex;
      position: relative;
    }}

    /* Cinematic Atmospheric Space Backdrop */
    .bg-backdrop {{
      position: absolute;
      inset: 0;
      background-image: url('{backdrop_b64}');
      background-size: cover;
      background-position: center right;
      opacity: 0.16;
      filter: saturate(1.4) contrast(1.2);
    }}

    .bg-backdrop-mask {{
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 75% 50%, rgba(6, 7, 10, 0.3) 0%, rgba(6, 7, 10, 0.95) 75%),
                  linear-gradient(90deg, #06070a 45%, rgba(6, 7, 10, 0.5) 75%, #06070a 100%);
    }}

    /* Glowing Ambient Lights */
    .ambient-glow-red {{
      position: absolute;
      top: -100px;
      left: -80px;
      width: 700px;
      height: 700px;
      background: radial-gradient(circle, rgba(229, 9, 20, 0.32) 0%, rgba(229, 9, 20, 0) 65%);
      pointer-events: none;
      filter: blur(55px);
    }}

    .ambient-glow-purple {{
      position: absolute;
      top: 40px;
      right: 20px;
      width: 800px;
      height: 700px;
      background: radial-gradient(circle, rgba(124, 58, 237, 0.38) 0%, rgba(124, 58, 237, 0) 65%);
      pointer-events: none;
      filter: blur(65px);
    }}

    .ambient-glow-amber {{
      position: absolute;
      bottom: -100px;
      left: 360px;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(245, 158, 11, 0.16) 0%, rgba(245, 158, 11, 0) 70%);
      pointer-events: none;
      filter: blur(50px);
    }}

    .grid-lines {{
      position: absolute;
      inset: 0;
      background-image: linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 40px 40px;
      pointer-events: none;
    }}

    /* Layout Frame */
    .container {{
      position: relative;
      z-index: 10;
      width: 100%;
      height: 100%;
      display: flex;
      padding: 48px 65px;
      align-items: center;
      justify-content: space-between;
    }}

    /* Left Copy Column */
    .left-col {{
      width: 580px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }}

    .brand-row {{
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 24px;
    }}

    .logo-badge {{
      width: 50px;
      height: 50px;
      border-radius: 14px;
      background: linear-gradient(135deg, #1f1f2e 0%, #11121a 100%);
      border: 1.5px solid rgba(229, 9, 20, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 25px rgba(229, 9, 20, 0.45);
    }}

    .logo-badge svg {{
      width: 26px;
      height: 26px;
    }}

    .brand-title {{
      font-family: 'Outfit', sans-serif;
      font-size: 38px;
      font-weight: 900;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
    }}

    .brand-title .brand-nova {{
      color: #ffffff;
    }}

    .brand-title .brand-zone {{
      color: #ff2a54;
      margin-left: 1px;
    }}

    .spec-pill {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 9999px;
      background: rgba(229, 9, 20, 0.15);
      border: 1px solid rgba(229, 9, 20, 0.45);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.8px;
      color: #ff758f;
      margin-left: 6px;
    }}

    .hook-pill {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      align-self: flex-start;
      padding: 6px 14px;
      border-radius: 9999px;
      background: rgba(255, 42, 84, 0.1);
      border: 1px solid rgba(255, 42, 84, 0.35);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: #ff94a8;
      margin-bottom: 16px;
    }}

    .hook-pill .live-indicator {{
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ff2a54;
      box-shadow: 0 0 10px #ff2a54;
    }}

    .headline {{
      font-family: 'Outfit', sans-serif;
      font-size: 48px;
      font-weight: 900;
      line-height: 1.12;
      letter-spacing: -1.2px;
      margin-bottom: 16px;
    }}

    .headline .gradient-accent {{
      background: linear-gradient(135deg, #ffffff 20%, #fbbf24 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }}

    .sub-lead {{
      font-size: 15.5px;
      line-height: 1.55;
      color: #94a3b8;
      font-weight: 500;
      margin-bottom: 26px;
      max-width: 530px;
    }}

    /* Clean 2x2 Feature Matrix */
    .features-grid {{
      display: grid;
      grid-template-columns: repeat(2, auto);
      gap: 10px 16px;
      justify-content: start;
      margin-bottom: 30px;
    }}

    .feature-tag {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(20, 22, 34, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      color: #e2e8f0;
      backdrop-filter: blur(8px);
    }}

    .feature-tag svg {{
      width: 15px;
      height: 15px;
      color: #ff2a54;
      flex-shrink: 0;
    }}

    /* CTA Row */
    .cta-row {{
      display: flex;
      align-items: center;
      gap: 18px;
    }}

    .primary-btn {{
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: #ffffff;
      color: #06070a;
      padding: 13px 26px;
      border-radius: 9999px;
      font-family: 'Outfit', sans-serif;
      font-size: 15.5px;
      font-weight: 800;
      letter-spacing: 0.2px;
      box-shadow: 0 4px 25px rgba(255, 255, 255, 0.25);
    }}

    .primary-btn svg {{
      width: 16px;
      height: 16px;
      fill: #06070a;
    }}

    .url-tag {{
      font-size: 13.5px;
      color: #64748b;
      font-weight: 600;
      letter-spacing: 0.3px;
    }}

    .url-tag strong {{
      color: #cbd5e1;
      font-weight: 700;
    }}

    /* Right Showcase Poster Deck (Polished Apple/Netflix Spread) */
    .right-col {{
      position: relative;
      width: 500px;
      height: 520px;
      display: flex;
      align-items: center;
      justify-content: center;
    }}

    .movie-card {{
      position: absolute;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.85);
      background: #141520;
    }}

    .movie-card img {{
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }}

    .movie-card .card-grad {{
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(6, 7, 10, 0) 35%, rgba(6, 7, 10, 0.8) 65%, rgba(6, 7, 10, 0.98) 100%);
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      padding: 14px 16px;
    }}

    .movie-card .c-title {{
      font-family: 'Outfit', sans-serif;
      font-size: 15px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 4px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.9);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }}

    .movie-card .c-meta {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      font-weight: 700;
    }}

    .c-meta .rating {{
      color: #f59e0b;
      display: flex;
      align-items: center;
      gap: 3px;
    }}

    .c-meta .pill {{
      background: rgba(229, 9, 20, 0.25);
      border: 1px solid rgba(229, 9, 20, 0.5);
      padding: 2px 7px;
      border-radius: 6px;
      color: #ff758f;
      font-size: 10px;
      font-weight: 800;
    }}

    /* Card 1: Left (Dune 2) */
    .card-dune {{
      width: 195px;
      height: 290px;
      left: -15px;
      top: 105px;
      transform: rotate(-10deg) scale(0.92);
      border: 1px solid rgba(255, 255, 255, 0.15);
      opacity: 0.9;
      z-index: 2;
    }}

    /* Card 2: Right (Spider-Man) */
    .card-spiderman {{
      width: 195px;
      height: 290px;
      right: -30px;
      top: 95px;
      transform: rotate(10deg) scale(0.92);
      border: 1px solid rgba(255, 255, 255, 0.15);
      opacity: 0.92;
      z-index: 3;
    }}

    .card-spiderman .card-grad {{
      padding: 14px 20px;
      align-items: flex-end;
    }}

    .card-spiderman .c-title {{
      text-align: right;
    }}

    .card-spiderman .c-meta {{
      width: 100%;
      justify-content: flex-end;
      gap: 10px;
    }}

    /* Card 3: Dominant Hero Center (Oppenheimer) */
    .card-hero {{
      width: 245px;
      height: 365px;
      left: 130px;
      top: 65px;
      transform: scale(1.04);
      border: 2px solid rgba(255, 42, 84, 0.85);
      box-shadow: 0 35px 70px rgba(0, 0, 0, 0.95), 0 0 45px rgba(229, 9, 20, 0.45);
      z-index: 10;
    }}

    .card-hero .card-grad {{
      background: linear-gradient(180deg, rgba(6, 7, 10, 0) 30%, rgba(6, 7, 10, 0.85) 60%, rgba(6, 7, 10, 1) 95%);
      padding: 18px 20px;
    }}

    .card-hero .c-title {{
      font-size: 21px;
      letter-spacing: -0.3px;
    }}

    .card-hero .top-badge {{
      position: absolute;
      top: 14px;
      left: 14px;
      background: linear-gradient(135deg, #ff2a54 0%, #e50914 100%);
      color: #ffffff;
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.8px;
      box-shadow: 0 4px 14px rgba(229, 9, 20, 0.5);
    }}
  </style>
</head>
<body>
  <div class="bg-backdrop"></div>
  <div class="bg-backdrop-mask"></div>
  <div class="ambient-glow-red"></div>
  <div class="ambient-glow-purple"></div>
  <div class="ambient-glow-amber"></div>
  <div class="grid-lines"></div>

  <div class="container">
    <!-- Left Column -->
    <div class="left-col">
      <div class="brand-row">
        <div class="logo-badge">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 4h4v16H4z" fill="#ff2a54"/>
            <path d="M4 4l12 16h4V4h-4v11L8 4H4z" fill="#ffffff"/>
            <path d="M16 4h4v16h-4z" fill="#ff2a54"/>
          </svg>
        </div>
        <div class="brand-title">
          <span class="brand-nova">NovaFlix</span><span class="brand-zone">Zone</span>
        </div>
        <div class="spec-pill">4K UHD • HDR</div>
      </div>

      <div class="hook-pill">
        <div class="live-indicator"></div>
        Stream & Download Hub
      </div>

      <div class="headline">
        <div>Unlimited Cinema.</div>
        <div class="gradient-accent">Zero Buffering.</div>
      </div>

      <div class="sub-lead">
        Stream the latest movies, trending series, and anime in pristine 4K UHD, or download directly to your local PC & mobile device.
      </div>

      <div class="features-grid">
        <div class="feature-tag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          Fast CDN Streaming
        </div>
        <div class="feature-tag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Direct Local Download
        </div>
        <div class="feature-tag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
          </svg>
          Dolby Atmos Audio
        </div>
        <div class="feature-tag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <polyline points="9 12 11 14 15 10"/>
          </svg>
          100% Free Access
        </div>
      </div>

      <div class="cta-row">
        <div class="primary-btn">
          <svg viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Start Watching Now
        </div>
        <div class="url-tag">
          Available at: <strong>novaflixzone.vercel.app</strong>
        </div>
      </div>
    </div>

    <!-- Right Floating Movie Posters Column -->
    <div class="right-col">
      <!-- Left Card (Dune 2) -->
      <div class="movie-card card-dune">
        <img src="{dune_b64}" alt="Dune: Part Two">
        <div class="card-grad">
          <div class="c-title">Dune: Part Two</div>
          <div class="c-meta">
            <div class="rating">★ 8.8</div>
            <div class="pill">4K HDR</div>
          </div>
        </div>
      </div>

      <!-- Right Card (Spider-Man) -->
      <div class="movie-card card-spiderman">
        <img src="{spiderman_b64}" alt="Spider-Man: Across the Spider-Verse">
        <div class="card-grad">
          <div class="c-title">Spider-Verse</div>
          <div class="c-meta">
            <div class="rating">★ 8.9</div>
            <div class="pill">4K UHD</div>
          </div>
        </div>
      </div>

      <!-- Center Card (Oppenheimer) -->
      <div class="movie-card card-hero">
        <div class="top-badge">FEATURED 4K</div>
        <img src="{oppenheimer_b64}" alt="Oppenheimer">
        <div class="card-grad">
          <div class="c-title">Oppenheimer</div>
          <div class="c-meta">
            <div class="rating">★ 8.9 IMDb</div>
            <div class="pill">IMAX 4K</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
"""

    html_file = os.path.abspath('scripts/og_template.html')
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(html_content)

    raw_screenshot = os.path.abspath('scripts/raw_screenshot.png')
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if not os.path.exists(edge_path):
        edge_path = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"

    cmd = [
        edge_path,
        '--headless=new',
        '--disable-gpu',
        '--window-size=1200,630',
        '--hide-scrollbars',
        '--virtual-time-budget=2000',
        '--run-all-compositor-stages-before-draw',
        f"--screenshot={raw_screenshot}",
        f"file:///{html_file.replace('\\', '/')}"
    ]
    print("Running Edge headless screenshot with virtual-time-budget=2000...")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("Edge error:", res.stderr)
        sys.exit(1)

    im = Image.open(raw_screenshot)
    if im.size != (1200, 630):
        print(f"Resizing/cropping from {im.size} to (1200, 630)...")
        im = im.crop((0, 0, 1200, 630))

    os.makedirs('web/public', exist_ok=True)
    jpg_path = os.path.abspath('web/public/og-image.jpg')
    png_path = os.path.abspath('web/public/og-image.png')

    rgb_im = im.convert('RGB')
    rgb_im.save(jpg_path, 'JPEG', quality=96, optimize=True)
    im.save(png_path, 'PNG', optimize=True)

    print(f"Successfully generated {jpg_path} ({os.path.getsize(jpg_path)} bytes)")
    print(f"Successfully generated {png_path} ({os.path.getsize(png_path)} bytes)")

if __name__ == '__main__':
    main()
