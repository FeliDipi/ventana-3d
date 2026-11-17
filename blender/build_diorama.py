"""
Genera el diorama de Ventana 3D: modela la escena, hornea la luz de Cycles en
texturas y exporta public/models/diorama.glb.

Uso (Blender en segundo plano):
    blender --background --factory-startup --python blender/build_diorama.py
    blender --background --factory-startup --python blender/build_diorama.py -- --preview

Con --preview solo modela y renderiza vistas de control en blender/preview/.

Convenciones: metros reales. El plano de la pantalla es Y = 0 y la escena se
extiende hacia +Y (el exportador glTF convierte a -Z de Three.js); +Z es arriba.
El ojo por defecto está en (0, -0.55, 0). El muro y las macetas se modelan en
tamaño real; el paisaje se modela a escala maqueta y se lleva a tamaño real con
M_REAL (ver REAL_K).
"""

import bmesh
import bpy
import math
import os
import random
import sys
import time
from mathutils import Matrix, Vector, noise

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAKE_DIR = os.path.join(ROOT, "blender", "bake")
PREVIEW_DIR = os.path.join(ROOT, "blender", "preview")
BLEND_PATH = os.path.join(ROOT, "blender", "diorama.blend")
GLB_PATH = os.path.join(ROOT, "public", "models", "diorama.glb")

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW_ONLY = "--preview" in ARGS

# Abertura de referencia (15,6" 16:9 en pantalla completa) y ojo por defecto.
AW, AH = 0.345, 0.194
EYE_D = 0.55

# Hueco de la ventana (algo menor que la abertura: el borde queda como marco).
HX, HZ = 0.157, 0.085
WALL_T = 0.06
GROUND_Z = -0.12

SUN_DIR = Vector((-0.9, 0.18, 0.40)).normalized()  # hacia el sol: izquierda, apenas al fondo

# Escala real. El paisaje (todo lo que está afuera, salvo el muro y las macetas) se
# modela en "coordenadas de maqueta" (cabaña de 24 cm a 2 m) y al final se escala
# REAL_K veces alrededor del ojo por defecto: desde ese punto la imagen no cambia,
# pero el parallax y el acercamiento pasan a ser los de un paisaje de tamaño real
# (cabaña de ~7 m a ~75 m, suelo ~3,6 m bajo la ventana, cordillera a cientos de m).
REAL_K = 30.0
EYE = Vector((0.0, -EYE_D, 0.0))
M_REAL = Matrix.Translation(EYE) @ Matrix.Scale(REAL_K, 4) @ Matrix.Translation(-EYE)
REAL_LAYERS = ("Ground", "Props", "Details", "Far", "Sky")

random.seed(7)


# ---------------------------------------------------------------- utilidades

def srgb(hexstr, k=1.0):
    """Hex sRGB -> RGB lineal (para atributos FLOAT_COLOR)."""
    h = hexstr.lstrip("#")
    out = []
    for i in range(3):
        c = int(h[i * 2:i * 2 + 2], 16) / 255
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        out.append(c * k)
    return tuple(out)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def scale_col(c, k):
    return tuple(x * k for x in c)


def ss(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def fbm(x, y, seed=0.0, octaves=4):
    v, a, f = 0.0, 0.5, 1.0
    for _ in range(octaves):
        v += a * noise.noise(Vector((x * f, y * f, seed)))
        a *= 0.5
        f *= 2.0
    return v


HAZE = srgb("#c7d2e0")


def hazed(col, f):
    """Perspectiva aérea: (albedo atenuado, emisión de bruma)."""
    return scale_col(col, 1 - f), scale_col(HAZE, f * 0.55)


# ------------------------------------------------------------------ capas

class Layer:
    """Acumula geometría con color por cara (albedo + emisión) en una sola malla."""

    def __init__(self, name, tex_size, custom_uv=False):
        self.name = name
        self.tex_size = tex_size
        self.custom_uv = custom_uv
        self.verts = []
        self.faces = []
        self.fcol = []
        self.femit = []
        self.vuv = []

    def add(self, verts, faces, col, emit=(0, 0, 0), jitter=0.06, uvs=None, fcols=None, femits=None):
        base = len(self.verts)
        self.verts.extend(verts)
        if uvs is not None:
            self.vuv.extend(uvs)
        for k, f in enumerate(faces):
            self.faces.append([base + i for i in f])
            c = fcols[k] if fcols else col
            if jitter:
                j = 1 + random.uniform(-jitter, jitter)
                c = (c[0] * j, c[1] * (j + random.uniform(-jitter, jitter) * 0.4), c[2] * j)
            self.fcol.append(c)
            self.femit.append(femits[k] if femits else emit)

    def add_bm(self, bm, matrix, col, emit=(0, 0, 0), jitter=0.06, vjitter=0.0):
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        verts = []
        for v in bm.verts:
            co = v.co.copy()
            if vjitter:
                co += Vector((random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-1, 1))) * vjitter
            verts.append(tuple(matrix @ co))
        faces = [[v.index for v in f.verts] for f in bm.faces]
        flip = matrix.determinant() < 0
        if flip:
            faces = [list(reversed(f)) for f in faces]
        bm.free()
        self.add(verts, faces, col, emit, jitter)


LAYERS = {
    "Window": Layer("Window", 2048),
    "Near": Layer("Near", 2048),
    "Ground": Layer("Ground", 4096, custom_uv=True),
    "Props": Layer("Props", 2048),
    # Piezas diminutas (pasto, flores): Lightmap Pack les da una celda por cara.
    "Details": Layer("Details", 1024),
    "Far": Layer("Far", 4096),
    "Sky": Layer("Sky", 1024, custom_uv=True),
}


# ------------------------------------------------------------- primitivas

def bm_box(sx, sy, sz):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    bm.verts.ensure_lookup_table()
    return bm


def bm_prism(r_bottom, r_top, h, seg):
    """Cilindro/cono facetado con base en z = 0."""
    bm = bmesh.new()
    bot = [bm.verts.new((r_bottom * math.cos(2 * math.pi * i / seg), r_bottom * math.sin(2 * math.pi * i / seg), 0)) for i in range(seg)]
    if r_top > 1e-6:
        top = [bm.verts.new((r_top * math.cos(2 * math.pi * i / seg), r_top * math.sin(2 * math.pi * i / seg), h)) for i in range(seg)]
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((bot[i], bot[j], top[j], top[i]))
        bm.faces.new(top)
    else:
        apex = bm.verts.new((0, 0, h))
        for i in range(seg):
            bm.faces.new((bot[i], bot[(i + 1) % seg], apex))
    bm.faces.new(list(reversed(bot)))
    bm.verts.ensure_lookup_table()
    return bm


def bm_ico(r, subdiv=1):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    bm.verts.ensure_lookup_table()
    return bm


def bm_octa(r):
    bm = bmesh.new()
    p = [bm.verts.new(c) for c in ((r, 0, 0), (-r, 0, 0), (0, r, 0), (0, -r, 0), (0, 0, r), (0, 0, -r))]
    for a, b in ((0, 2), (2, 1), (1, 3), (3, 0)):
        bm.faces.new((p[a], p[b], p[4]))
        bm.faces.new((p[b], p[a], p[5]))
    return bm


def T(x=0.0, y=0.0, z=0.0, rz=0.0, rx=0.0, ry=0.0, s=(1, 1, 1)):
    m = Matrix.Translation((x, y, z))
    m = m @ Matrix.Rotation(rz, 4, "Z") @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rx, 4, "X")
    return m @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))


def box(layer, x0, x1, y0, y1, z0, z1, col, emit=(0, 0, 0), jitter=0.03, m=None):
    bm = bm_box(x1 - x0, y1 - y0, z1 - z0)
    mm = Matrix.Translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    LAYERS[layer].add_bm(bm, (m @ mm) if m else mm, col, emit, jitter)


# ---------------------------------------------------------------- terreno

POND = (0.48, 1.05, 0.21, 0.13)  # cx, cy, rx, ry
CABIN = (-0.46, 1.95, math.radians(18))
PATH = [(0.02, 0.05), (0.0, 0.35), (-0.08, 0.7), (-0.2, 1.1), (-0.3, 1.45), (-0.38, 1.72)]
PATH_W = 0.045
WATER_Z = GROUND_Z - 0.011


def path_dist(x, y):
    best = 1e9
    for (ax, ay), (bx, by) in zip(PATH, PATH[1:]):
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(x - ax - t * dx, y - ay - t * dy))
    return best


def pond_d(x, y):
    cx, cy, rx, ry = POND
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2


def height(x, y):
    z = GROUND_Z + fbm(x * 2.4, y * 2.4) * 0.012
    z -= 0.10 * ss(1.9, 3.2, y)
    z += 0.55 * ss(3.2, 7.0, y) * (0.55 + 0.45 * fbm(x * 0.33, y * 0.33, 3.1))
    z += fbm(x * 0.55, y * 0.55, 1.7) * 0.18 * ss(2.4, 7.0, y)
    # Claro plano para la cabaña.
    cx, cy, _ = CABIN
    dc = math.hypot(x - cx, y - cy)
    z = z + (GROUND_Z - z) * (1 - ss(0.18, 0.32, dc))
    # Sendero apenas hundido.
    z -= 0.003 * (1 - ss(PATH_W * 0.6, PATH_W, path_dist(x, y))) * (1 - ss(1.6, 1.9, y))
    # Estanque.
    d = pond_d(x, y)
    if d < 1.0:
        z = WATER_Z
    elif d < 1.7:
        z = WATER_Z + (z - WATER_Z) * ss(1.0, 1.7, d)
    return z


GRASS = srgb("#6e9a43")
GRASS2 = srgb("#8ab352")
DRY = srgb("#a9a35a")
FIELD = [srgb("#d1b85e"), srgb("#8fb04c"), srgb("#79a046"), srgb("#a7b552"), srgb("#5f8c3e")]
SAND = srgb("#c6a678")
WATER = srgb("#3b78a3")
WATER_DEEP = srgb("#2c5a86")


def ground_color(x, y, z):
    d = pond_d(x, y)
    if d < 1.0:
        return mix(WATER, WATER_DEEP, 1 - d), scale_col(srgb("#9fc3e8"), 0.18)
    if d < 1.35:
        return SAND, (0, 0, 0)
    if path_dist(x, y) < PATH_W and y < 1.75:
        return SAND, (0, 0, 0)
    n = fbm(x * 3.1, y * 3.1, 9.0)
    c = mix(GRASS, GRASS2, 0.5 + n)
    c = mix(c, DRY, max(0.0, fbm(x * 1.3, y * 1.3, 4.0)) * 0.45)
    if y > 2.3:
        # Campos de cultivo en la lejanía.
        cell = fbm(x * 0.9, y * 0.9, 12.0)
        idx = int((cell + 1) * 2.6) % len(FIELD)
        c = mix(c, FIELD[idx], 0.6 * ss(2.3, 3.0, y))
    return hazed(c, 0.45 * ss(1.8, 7.5, y))


def build_ground():
    lay = LAYERS["Ground"]
    rng_state = random.getstate()
    # Tramo cercano (pegado a la casa, ~3–17 m reales: solo se ve al subir la cabeza)
    # + tramo principal con filas más densas cerca.
    NI, NNEAR, NMAIN = 120, 20, 150
    NJ = NNEAR + NMAIN
    yn, y0, y1 = -0.43, 0.03, 7.6
    verts, uvs = [], []
    for j in range(NJ + 1):
        t = j / NJ
        if j <= NNEAR:
            y = yn + (y0 - yn) * j / NNEAR
        else:
            y = y0 + (y1 - y0) * ((j - NNEAR) / NMAIN) ** 1.7
        # Semiancho: cubre el frustum con margen también cerca de la casa.
        hw = max(0.565 + y, 0.35 + 1.12 * y)
        for i in range(NI + 1):
            x = hw * (2 * i / NI - 1)
            # Jitter leve en XY para romper la grilla (no en el borde).
            if 0 < i < NI and 0 < j < NJ:
                x += random.uniform(-0.3, 0.3) * (2 * hw / NI)
            verts.append((x, y, height(x, y)))
            uvs.append((i / NI, t))
    faces, fcols, femits = [], [], []
    for j in range(NJ):
        for i in range(NI):
            a = j * (NI + 1) + i
            b, c, d = a + 1, a + NI + 2, a + NI + 1
            for tri in ((a, b, c), (a, c, d)) if (i + j) % 2 == 0 else ((a, b, d), (b, c, d)):
                cx = sum(verts[k][0] for k in tri) / 3
                cy = sum(verts[k][1] for k in tri) / 3
                cz = sum(verts[k][2] for k in tri) / 3
                col, emit = ground_color(cx, cy, cz)
                faces.append(list(tri))
                fcols.append(col)
                femits.append(emit)
    lay.add(verts, faces, None, uvs=uvs, fcols=fcols, femits=femits, jitter=0.05)
    # Deja el RNG global como lo dejaba la grilla original (120 x 150) para que el resto
    # de la composición (árboles dispersos, hojas, flores) no cambie.
    random.setstate(rng_state)
    for _ in range(119 * 149 + 120 * 150 * 2 * 2):
        random.random()


# --------------------------------------------------------------- ventana

def build_window():
    paint = srgb("#efe6d6")
    wood = srgb("#e4d6bf")
    L = "Window"
    W, H = 0.70, 0.40  # extensión del muro (lo que sobra queda fuera de cuadro)
    # Muro con hueco (4 bloques).
    box(L, -W, -HX, 0, WALL_T, -H, H, paint)
    box(L, HX, W, 0, WALL_T, -H, H, paint)
    box(L, -HX, HX, 0, WALL_T, HZ, H, paint)
    box(L, -HX, HX, 0, WALL_T, -H, -HZ, paint)
    # Contramarco (listón de tope) dentro del hueco.
    b, y0, y1 = 0.007, 0.034, 0.046
    box(L, -HX, -HX + b, y0, y1, -HZ, HZ, wood)
    box(L, HX - b, HX, y0, y1, -HZ, HZ, wood)
    box(L, -HX, HX, y0, y1, HZ - b, HZ, wood)
    box(L, -HX, HX, y0, y1, -HZ, -HZ + b, wood)
    # Alféizar exterior.
    box(L, -HX - 0.025, HX + 0.025, WALL_T - 0.004, WALL_T + 0.075, -HZ - 0.014, -HZ, srgb("#d8cdbb"))
    # Muro exterior (revoque) bajo el alféizar, hasta el suelo.
    # (el muro no se escala: baja hasta el suelo real, ~3,6 m)
    box(L, -W, W, WALL_T - 0.002, WALL_T + 0.004, GROUND_Z * REAL_K - 0.5, -HZ - 0.014, srgb("#c9b9a0"))


# ------------------------------------------------------------ primer plano

LEAF = [srgb("#4f8a3a"), srgb("#5f9c41"), srgb("#3f7432"), srgb("#6aa84a")]


def leaf(layer, x, y, z, size, rz=None, tilt=None, col=None):
    bm = bm_ico(1.0, 1)
    rz = random.uniform(0, math.tau) if rz is None else rz
    tilt = random.uniform(-0.6, 0.6) if tilt is None else tilt
    m = T(x, y, z, rz=rz, rx=tilt, s=(size * 0.55, size * 0.3, size))
    LAYERS[layer].add_bm(bm, m, col or random.choice(LEAF), jitter=0.08, vjitter=0.12)


def scale_since(layer, start, pivot, s):
    """Escala uniforme, alrededor de `pivot`, de los vértices agregados desde `start`."""
    p = Vector(pivot)
    for i in range(start, len(layer.verts)):
        layer.verts[i] = tuple(p + (Vector(layer.verts[i]) - p) * s)


POT_SCALE = 1.15  # macetas de ~5,5 cm: tamaño real de una suculenta de alféizar


def build_near():
    L = "Near"
    lay = LAYERS[L]
    sill = -HZ
    terracotta = srgb("#b8623d")
    soil = srgb("#4a3424")
    # Maceta grande con planta florida (izquierda).
    start = len(lay.verts)
    px, py = -0.098, WALL_T + 0.036
    LAYERS[L].add_bm(bm_prism(0.017, 0.024, 0.040, 10), T(px, py, sill), terracotta, jitter=0.04)
    LAYERS[L].add_bm(bm_prism(0.026, 0.026, 0.007, 10), T(px, py, sill + 0.036), scale_col(terracotta, 1.08), jitter=0.04)
    LAYERS[L].add_bm(bm_prism(0.022, 0.022, 0.002, 10), T(px, py, sill + 0.038), soil)
    for k in range(26):
        a = random.uniform(0, math.tau)
        r = random.uniform(0.0, 0.03)
        h = random.uniform(0.045, 0.085)
        leaf(L, px + math.cos(a) * r, py + math.sin(a) * r * 0.8, sill + h, random.uniform(0.010, 0.016))
    for k in range(9):
        a = random.uniform(0, math.tau)
        r = random.uniform(0.0, 0.028)
        col = random.choice([srgb("#e0463a"), srgb("#f07a3c"), srgb("#e9466e")])
        LAYERS[L].add_bm(bm_ico(0.0055, 1), T(px + math.cos(a) * r, py + math.sin(a) * r * 0.8, sill + random.uniform(0.075, 0.098)), col, jitter=0.08, vjitter=0.0008)
    scale_since(lay, start, (px, py, sill), POT_SCALE)
    # Maceta chica con cactus (derecha).
    start = len(lay.verts)
    qx, qy = 0.106, WALL_T + 0.032
    LAYERS[L].add_bm(bm_prism(0.012, 0.016, 0.026, 8), T(qx, qy, sill), srgb("#9c5537"), jitter=0.04)
    LAYERS[L].add_bm(bm_prism(0.014, 0.014, 0.002, 8), T(qx, qy, sill + 0.024), soil)
    LAYERS[L].add_bm(bm_ico(1.0, 2), T(qx, qy, sill + 0.044, s=(0.012, 0.012, 0.024)), srgb("#5b8f4e"), jitter=0.05)
    LAYERS[L].add_bm(bm_ico(1.0, 1), T(qx + 0.012, qy, sill + 0.04, ry=0.5, s=(0.006, 0.006, 0.011)), srgb("#5b8f4e"), jitter=0.05)
    LAYERS[L].add_bm(bm_octa(0.005), T(qx, qy, sill + 0.069), srgb("#f2a0c4"), jitter=0.05)
    scale_since(lay, start, (qx, qy, sill), POT_SCALE)
    # Enredadera que cuelga desde arriba a la derecha (por fuera del muro).
    vx, vy = 0.085, WALL_T + 0.014
    z = HZ + 0.03
    for k in range(34):
        z -= random.uniform(0.003, 0.0055)
        vx += random.uniform(-0.002, 0.004)
        leaf(L, vx + random.uniform(-0.006, 0.006), vy + random.uniform(0, 0.012), z, random.uniform(0.009, 0.013), tilt=random.uniform(-1.2, 1.2))
        if z < 0.0:
            break
    for k in range(18):
        leaf(L, random.uniform(0.04, 0.16), WALL_T + random.uniform(0.005, 0.02), HZ + random.uniform(-0.012, 0.01), random.uniform(0.010, 0.014), tilt=random.uniform(-1.4, 1.4))


# ---------------------------------------------------------------- utilería

BARK = srgb("#6b4a30")
PINE = [srgb("#2f5a35"), srgb("#3a6a3a"), srgb("#28503a")]
CROWN = [srgb("#5c8f3c"), srgb("#6f9f42"), srgb("#4d7f37"), srgb("#86a845")]


def haze_for(y):
    return 0.42 * ss(1.6, 7.5, y)


def tree_decid(x, y, s):
    z0 = height(x, y)
    f = haze_for(y)
    col, emit = hazed(BARK, f)
    LAYERS["Props"].add_bm(bm_prism(0.012 * s, 0.008 * s, 0.17 * s, 6), T(x, y, z0 - 0.01), col, emit)
    base = random.choice(CROWN)
    for k in range(random.randint(3, 5)):
        r = random.uniform(0.055, 0.085) * s
        c, e = hazed(mix(base, random.choice(CROWN), 0.4), f)
        LAYERS["Props"].add_bm(
            bm_ico(r, 1),
            T(x + random.uniform(-0.05, 0.05) * s, y + random.uniform(-0.04, 0.04) * s, z0 + (0.17 + random.uniform(0.0, 0.09)) * s),
            c, e, jitter=0.07, vjitter=r * 0.16)


def tree_pine(x, y, s):
    z0 = height(x, y)
    f = haze_for(y)
    col, emit = hazed(BARK, f)
    LAYERS["Props"].add_bm(bm_prism(0.008 * s, 0.006 * s, 0.07 * s, 6), T(x, y, z0 - 0.01), col, emit)
    c0 = random.choice(PINE)
    for k, (r, h) in enumerate(((0.075, 0.12), (0.06, 0.11), (0.042, 0.10))):
        c, e = hazed(scale_col(c0, 1 + 0.08 * k), f)
        LAYERS["Props"].add_bm(bm_prism(r * s, 0, h * s, 8), T(x, y, z0 + (0.05 + k * 0.065) * s, rz=random.uniform(0, 1)), c, e, jitter=0.05, vjitter=0.004 * s)


def rock(x, y, r, flat=0.6):
    z0 = height(x, y)
    c, e = hazed(random.choice([srgb("#8e8a84"), srgb("#7d7a76"), srgb("#a09a90")]), haze_for(y))
    LAYERS["Props"].add_bm(bm_ico(1.0, 1), T(x, y, z0 + r * flat * 0.35, rz=random.uniform(0, 6), s=(r, r * 0.85, r * flat)), c, e, jitter=0.06, vjitter=0.22)


def bush(x, y, r):
    z0 = height(x, y)
    for k in range(3):
        rr = r * random.uniform(0.7, 1.0)
        c, e = hazed(random.choice(CROWN), haze_for(y))
        LAYERS["Props"].add_bm(bm_ico(rr, 1), T(x + random.uniform(-r, r) * 0.6, y + random.uniform(-r, r) * 0.5, z0 + rr * 0.45, s=(1, 1, 0.75)), c, e, jitter=0.07, vjitter=rr * 0.15)


def cabin():
    cx, cy, yaw = CABIN
    z0 = GROUND_Z
    M = T(cx, cy, z0, rz=yaw)
    w, d, h = 0.24, 0.17, 0.12
    box("Props", -w / 2 - 0.006, w / 2 + 0.006, -d / 2 - 0.006, d / 2 + 0.006, -0.02, 0.012, srgb("#8d877d"), m=M)
    box("Props", -w / 2, w / 2, -d / 2, d / 2, 0.012, h, srgb("#d9c7a3"), m=M)
    # Techo a dos aguas (cumbrera paralela a X).
    pitch = math.radians(34)
    half = d / 2 + 0.03
    slab = half / math.cos(pitch)
    for sgn in (-1, 1):
        R = M @ T(0, sgn * half / 2, h + math.tan(pitch) * half / 2, rx=-sgn * pitch)
        box("Props", -w / 2 - 0.025, w / 2 + 0.025, -slab / 2, slab / 2, -0.006, 0.006, srgb("#9a3b2c"), m=R)
    # Hastiales triangulares.
    ridge_h = math.tan(pitch) * (d / 2)
    for sx in (-w / 2, w / 2):
        v = [tuple(M @ Vector(p)) for p in ((sx, -d / 2, h), (sx, d / 2, h), (sx, 0, h + ridge_h))]
        LAYERS["Props"].add(v, [[0, 1, 2] if sx > 0 else [0, 2, 1]], srgb("#d4c19c"), jitter=0.02)
    # Puerta y ventanas iluminadas sobre la fachada que mira al espectador (-Y local).
    fy = -d / 2 - 0.002
    box("Props", -0.02, 0.02, fy - 0.003, fy + 0.002, 0.012, 0.085, srgb("#5a3b27"), m=M)
    warm = srgb("#ffc77a", 1.0)
    for wx in (-0.075, 0.075):
        box("Props", wx - 0.022, wx + 0.022, fy - 0.004, fy + 0.002, 0.05, 0.092, srgb("#6b4a30"), m=M)
        box("Props", wx - 0.016, wx + 0.016, fy - 0.006, fy + 0.002, 0.056, 0.086, (0.05, 0.04, 0.02), scale_col(warm, 1.6), m=M)
    # Chimenea.
    box("Props", 0.06, 0.095, 0.01, 0.045, h, h + ridge_h + 0.05, srgb("#7f786f"), m=M)


def fence():
    a, b = Vector((-0.78, 0.52)), Vector((-0.13, 0.62))
    n = 10
    wood = srgb("#8a6b4a")
    dirv = (b - a).normalized()
    yaw = math.atan2(dirv.y, dirv.x)
    for k in range(n + 1):
        p = a.lerp(b, k / n)
        z0 = height(p.x, p.y)
        box("Details", -0.0045, 0.0045, -0.0045, 0.0045, -0.01, 0.06, wood, m=T(p.x, p.y, z0, rz=yaw + random.uniform(-0.08, 0.08)))
    L = (b - a).length
    mid = (a + b) / 2
    for zr in (0.022, 0.046):
        z0 = height(mid.x, mid.y)
        box("Details", -L / 2, L / 2, -0.003, 0.003, zr - 0.004, zr + 0.004, wood, m=T(mid.x, mid.y, z0, rz=yaw))


def lamp(x, y):
    z0 = height(x, y)
    LAYERS["Details"].add_bm(bm_prism(0.003, 0.003, 0.11, 6), T(x, y, z0), srgb("#2f2f33"), jitter=0.02)
    LAYERS["Details"].add_bm(bm_ico(0.009, 1), T(x, y, z0 + 0.118), (0.1, 0.08, 0.05), scale_col(srgb("#ffd08a"), 2.0), jitter=0.0)


def is_free(x, y, clear=0.08):
    if pond_d(x, y) < 1.9 or path_dist(x, y) < PATH_W + clear * 0.5:
        return False
    if math.hypot(x - CABIN[0], y - CABIN[1]) < 0.3:
        return False
    return True


def build_props():
    # Árboles de composición (a mano) + relleno disperso.
    tree_decid(0.44, 0.42, 1.3)
    tree_pine(-0.58, 0.85, 1.05)
    tree_pine(-0.80, 1.30, 1.2)
    tree_decid(-0.95, 1.0, 1.1)
    tree_decid(0.82, 1.55, 1.25)
    tree_pine(1.15, 2.35, 1.45)
    tree_decid(-1.15, 2.55, 1.35)
    tree_pine(-0.35, 2.75, 1.4)
    tree_pine(-0.18, 3.0, 1.2)
    placed = 0
    tries = 0
    while placed < 60 and tries < 6000:
        tries += 1
        y = random.uniform(2.2, 7.2)
        hw = 0.35 + 1.12 * y
        x = random.uniform(-hw * 0.95, hw * 0.95)
        if not is_free(x, y):
            continue
        # Corredor visual libre hacia las montañas (centro-derecha de la vista).
        in_corridor = abs(x - 0.25 * y) < 0.32 * y
        if in_corridor and (y < 3.2 or random.random() > 0.3):
            continue
        s = random.uniform(0.8, 1.5) * (1 + y * 0.1) * (0.6 if in_corridor else 1.0)
        (tree_pine if random.random() < 0.55 else tree_decid)(x, y, s)
        placed += 1
    cabin()
    fence()
    lamp(-0.14, 1.32)
    for (x, y, r) in ((0.22, 0.28, 0.022), (0.66, 0.98, 0.035), (0.27, 1.12, 0.025), (0.62, 1.18, 0.02),
                      (-0.14, 0.95, 0.018), (0.95, 2.05, 0.05), (-0.42, 0.45, 0.02)):
        rock(x, y, r)
    for (x, y, r) in ((-0.22, 0.32, 0.03), (0.13, 0.78, 0.035), (-0.62, 1.12, 0.045), (0.6, 1.4, 0.04),
                      (-0.25, 1.62, 0.03), (-0.66, 1.9, 0.05), (0.25, 1.6, 0.03)):
        bush(x, y, r)
    # Matas de pasto y flores cerca de la ventana.
    tuft = srgb("#5f8f3a")
    for k in range(260):
        y = random.uniform(0.1, 1.6)
        x = random.uniform(-(0.35 + 0.9 * y), 0.35 + 0.9 * y)
        if not is_free(x, y, 0.02):
            continue
        z0 = height(x, y)
        for b in range(3):
            LAYERS["Details"].add_bm(bm_prism(0.0028, 0, random.uniform(0.012, 0.024), 3),
                                   T(x + random.uniform(-0.005, 0.005), y + random.uniform(-0.005, 0.005), z0 - 0.002,
                                     rz=random.uniform(0, 6), rx=random.uniform(-0.35, 0.35)),
                                   mix(tuft, GRASS2, random.random()), jitter=0.08)
    petals = [srgb("#f4f1e8"), srgb("#f4f1e8"), srgb("#f2cc3d"), srgb("#f2cc3d"), srgb("#e8789c"), srgb("#b59be0")]
    for k in range(80):
        y = random.uniform(0.12, 1.5)
        side = random.choice((-1, 1))
        # Cerca del borde del sendero.
        t = random.random()
        i = min(int(t * (len(PATH) - 1)), len(PATH) - 2)
        (ax, ay), (bx, by) = PATH[i], PATH[i + 1]
        u = t * (len(PATH) - 1) - i
        x = ax + (bx - ax) * u + side * random.uniform(PATH_W * 1.1, PATH_W * 3.5)
        y = ay + (by - ay) * u + random.uniform(-0.03, 0.03)
        z0 = height(x, y)
        LAYERS["Details"].add_bm(bm_octa(random.uniform(0.0028, 0.004)), T(x, y, z0 + random.uniform(0.004, 0.009)), random.choice(petals), jitter=0.05)
    # Nenúfares.
    for (x, y) in ((0.42, 1.0), (0.55, 1.09), (0.5, 0.97)):
        LAYERS["Details"].add_bm(bm_prism(0.018, 0.018, 0.0015, 9), T(x, y, WATER_Z + 0.0005), srgb("#5c9a45"), jitter=0.05)
    # Pie de la casa (~5–17 m reales): solo se ve al asomarse (cabeza arriba).
    for (x, y, r) in ((-0.12, -0.34, 0.022), (0.05, -0.3, 0.018), (0.16, -0.22, 0.025), (-0.2, -0.16, 0.03), (0.02, -0.1, 0.02)):
        bush(x, y, r)
    for k in range(90):
        y = random.uniform(-0.38, 0.1)
        hw = 0.565 + y
        x = random.uniform(-hw, hw)
        z0 = height(x, y)
        for b in range(3):
            LAYERS["Details"].add_bm(bm_prism(0.0028, 0, random.uniform(0.012, 0.024), 3),
                                   T(x + random.uniform(-0.005, 0.005), y + random.uniform(-0.005, 0.005), z0 - 0.002,
                                     rz=random.uniform(0, 6), rx=random.uniform(-0.35, 0.35)),
                                   mix(tuft, GRASS2, random.random()), jitter=0.08)


# --------------------------------------------------------------- lejanía

def ridge(yc, depth, half_w, base_z, peaks, hmin, hmax, f_haze, cols, snow=None, seed=0.0, ni=150):
    lay = LAYERS["Far"]
    rng = random.Random(seed)
    pk = [(rng.uniform(-half_w, half_w), rng.uniform(hmin, hmax), rng.uniform(1.2, 3.5) * (half_w / 16)) for _ in range(peaks)]

    def H(x):
        h = sum(p[1] * math.exp(-((x - p[0]) / p[2]) ** 2) for p in pk)
        return h + (fbm(x * 0.35, seed, seed, 3) * 0.5 + 0.5) * hmin * 0.6

    nj = 7
    verts = []
    for j in range(nj + 1):
        t = j / nj
        y = yc - depth + 2 * depth * t
        prof = math.sin(math.pi * t) ** 0.8
        for i in range(ni + 1):
            x = -half_w + 2 * half_w * i / ni + (rng.uniform(-0.3, 0.3) * half_w / ni if 0 < i < ni else 0)
            z = base_z + H(x) * prof + fbm(x * 0.8, y * 0.8, seed + 5, 2) * 0.12 * hmax * prof
            verts.append((x, y, z))
    faces, fc, fe = [], [], []
    for j in range(nj):
        for i in range(ni):
            a = j * (ni + 1) + i
            b, c, d = a + 1, a + ni + 2, a + ni + 1
            for tri in ((a, b, c), (a, c, d)):
                zc = sum(verts[k][2] for k in tri) / 3
                col = rng.choice(cols)
                if snow is not None and zc > snow + rng.uniform(-0.15, 0.15) * hmax:
                    col = srgb("#f3f5f8")
                c2, e2 = hazed(col, f_haze)
                faces.append(list(tri))
                fc.append(c2)
                fe.append(e2)
    lay.add(verts, faces, None, fcols=fc, femits=fe, jitter=0.05)


def cloud(x, y, z, s):
    for k in range(random.randint(4, 7)):
        r = s * random.uniform(0.45, 0.8)
        c, e = hazed(srgb("#ffffff"), 0.25)
        LAYERS["Far"].add_bm(bm_ico(r, 1), T(x + random.uniform(-1.2, 1.2) * s, y + random.uniform(-0.4, 0.4) * s, z + random.uniform(-0.15, 0.25) * s,
                                             s=(1.0, 0.8, 0.55)), c, e, jitter=0.04, vjitter=r * 0.12)


def build_far():
    ridge(9.5, 2.0, 17, -0.4, 14, 0.5, 1.3, 0.3, [srgb("#3c6a40"), srgb("#4f7f45"), srgb("#2f5a3c"), srgb("#5d8a4a")], seed=1.0)
    ridge(19.0, 4.0, 32, -1.2, 11, 1.6, 4.2, 0.6, [srgb("#6e7690"), srgb("#7b8299"), srgb("#646b85")], snow=2.6, seed=2.0)
    for (x, y, z, s) in ((-9, 32, 6.0, 1.8), (-2, 38, 7.2, 2.4), (7, 30, 5.2, 1.6), (15, 40, 8.0, 2.6), (-18, 42, 7.8, 2.2), (2, 26, 4.6, 1.2)):
        cloud(x, y, z, s)


SKY_R = 60.0


def sky_color(d):
    zen, mid_, hor, below = srgb("#2f63b0"), srgb("#7aa6dc"), srgb("#f1d8b8"), srgb("#c7d2e0")
    e = d.z
    if e < 0:
        c = mix(hor, below, ss(0.0, 0.12, -e))
    else:
        c = mix(hor, mid_, ss(0.0, 0.25, e))
        c = mix(c, zen, ss(0.25, 0.9, e))
    glow = max(0.0, d.dot(SUN_DIR))
    c = mix(c, srgb("#ffcf94"), 0.75 * glow ** 6)
    return c


def build_sky():
    lay = LAYERS["Sky"]
    NI, NJ = 96, 40
    e0, e1 = math.radians(-20), math.radians(90)
    verts, uvs, dirs = [], [], []
    for j in range(NJ + 1):
        t = j / NJ
        el = e0 + (e1 - e0) * t
        for i in range(NI + 1):
            # Costura detrás del espectador (-Y).
            az = -math.pi / 2 + math.tau * i / NI
            d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
            verts.append(tuple(d * SKY_R))
            uvs.append((i / NI, t))
            dirs.append(d)
    faces, fc, fe = [], [], []
    for j in range(NJ):
        for i in range(NI):
            a = j * (NI + 1) + i
            b, c, d = a + 1, a + NI + 2, a + NI + 1
            faces.append([a, d, c, b])  # normales hacia adentro
            fc.append((0, 0, 0))
            fe.append((0, 0, 0))
    lay.add(verts, faces, None, uvs=uvs, fcols=fc, femits=fe, jitter=0)
    lay.vertex_emit = [sky_color(d) for d in dirs]


# ---------------------------------------------------------- escena Blender

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    sc.render.engine = "CYCLES"
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    cy = sc.cycles
    cy.samples = 64
    cy.max_bounces = 6
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 1
    cy.use_denoising = True
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in devs:
                d.use = True
            cy.device = "GPU"
            print(f"[diorama] Cycles en GPU ({kind}): {[d.name for d in devs]}")
            break
    else:
        print("[diorama] Cycles en CPU")


def make_world():
    w = bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (*srgb("#8a8f86"), 1)
    els[1].position, els[1].color = 0.55, (*srgb("#4f7fc0"), 1)
    mid = els.new(0.5)
    mid.color = (*srgb("#e8dcc8"), 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.55
    nt.links.new(bg.outputs[0], out.inputs[0])

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 5.0
    sun.angle = math.radians(2.5)
    sun.color = srgb("#ffd9ad")
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = (-SUN_DIR).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(so)

    # Luz de la habitación detrás del espectador: ilumina el marco interior.
    room = bpy.data.lights.new("RoomLight", "AREA")
    room.energy = 5.0
    room.size = 1.2
    room.color = srgb("#ffe3c2")
    ro = bpy.data.objects.new("RoomLight", room)
    ro.location = (0.1, -0.9, 0.25)
    ro.rotation_euler = Vector((0, 1, -0.2)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(ro)


def base_material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "Col"
    emit = nt.nodes.new("ShaderNodeAttribute")
    emit.attribute_name = "Emit"
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(emit.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return m


def create_object(lay):
    me = bpy.data.meshes.new(lay.name)
    me.from_pydata(lay.verts, [], lay.faces)
    me.validate(clean_customdata=False)
    me.update()
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    emi = me.color_attributes.new("Emit", "FLOAT_COLOR", "CORNER")
    vemit = getattr(lay, "vertex_emit", None)
    for p in me.polygons:
        c = lay.fcol[p.index]
        e = lay.femit[p.index]
        for li in p.loop_indices:
            col.data[li].color = (*c, 1.0)
            if vemit is not None:
                e = vemit[me.loops[li].vertex_index]
            emi.data[li].color = (*e, 1.0)
    if lay.custom_uv:
        uv = me.uv_layers.new(name="UVMap")
        for li, loop in enumerate(me.loops):
            uv.data[li].uv = lay.vuv[loop.vertex_index]
    ob = bpy.data.objects.new(lay.name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(base_material(f"{lay.name}_src"))
    if lay.name == "Sky":
        for attr in ("visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter", "visible_shadow"):
            setattr(ob, attr, False)
    print(f"[diorama] {lay.name}: {len(me.vertices)} vértices, {len(me.polygons)} caras")
    return ob


def select_only(ob):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def unwrap(ob):
    select_only(ob)
    ob.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    if ob.name == "Details":
        bpy.ops.uv.lightmap_pack(PREF_CONTEXT="ALL_FACES", PREF_PACK_IN_ONE=True, PREF_NEW_UVLAYER=False, PREF_MARGIN_DIV=0.3)
    else:
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def preview_camera(name, ex, ez, d):
    cam = bpy.data.cameras.new(name)
    cam.sensor_fit = "HORIZONTAL"
    cam.sensor_width = 36.0
    cam.lens = 36.0 * d / AW
    cam.shift_x = -ex / AW
    cam.shift_y = -ez / AW
    cam.clip_start = 0.01
    cam.clip_end = 4000  # cielo a SKY_R * REAL_K = 1800 m
    ob = bpy.data.objects.new(name, cam)
    ob.location = (ex, -d, ez)
    ob.rotation_euler = (math.pi / 2, 0, 0)  # mira +Y
    bpy.context.scene.collection.objects.link(ob)
    return ob


def render_previews(tag):
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.image_settings.file_format = "PNG"
    sc.cycles.samples = 48
    for name, ex, ez, d in (("centro", 0, 0, EYE_D), ("izq", -0.15, 0.03, 0.5), ("der", 0.15, -0.04, 0.5), ("cerca", 0.05, 0.08, 0.32),
                            ("arriba", 0.0, 0.14, 0.45)):
        cam = preview_camera(f"Cam_{name}", ex, ez, d)
        sc.camera = cam
        sc.render.filepath = os.path.join(PREVIEW_DIR, f"{tag}_{name}.png")
        t = time.time()
        bpy.ops.render.render(write_still=True)
        print(f"[diorama] preview {tag}_{name} ({time.time() - t:.1f}s)")


def bake_layer(ob, size):
    w, h = (size, size // 2) if ob.name == "Sky" else (size, size)
    img = bpy.data.images.new(f"{ob.name}_bake", w, h, alpha=False, float_buffer=False)
    for slot in ob.material_slots:
        nt = slot.material.node_tree
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        for n in nt.nodes:
            n.select = False
        node.select = True
        nt.nodes.active = node
    select_only(ob)
    sc = bpy.context.scene
    bk = sc.render.bake
    bk.margin = 12
    bk.margin_type = "EXTEND"
    bk.use_pass_direct = True
    bk.use_pass_indirect = True
    bk.use_pass_diffuse = True
    bk.use_pass_glossy = False
    bk.use_pass_transmission = True
    bk.use_pass_emit = True
    sc.cycles.samples = 64 if ob.name in ("Ground", "Far") else 128
    t = time.time()
    bpy.ops.object.bake(type="EMIT" if ob.name == "Sky" else "COMBINED")
    os.makedirs(BAKE_DIR, exist_ok=True)
    img.filepath_raw = os.path.join(BAKE_DIR, f"{ob.name}.png")
    img.file_format = "PNG"
    img.save()
    print(f"[diorama] horneado {ob.name} {w}x{h} ({time.time() - t:.1f}s)")
    return img


def baked_material(ob, img):
    m = bpy.data.materials.new(f"{ob.name}_baked")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    ob.data.materials.clear()
    ob.data.materials.append(m)
    # El GLB solo necesita el UV del horneado.
    for attr in list(ob.data.color_attributes):
        ob.data.color_attributes.remove(attr)


def export_glb(objs):
    os.makedirs(os.path.dirname(GLB_PATH), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=GLB_PATH, export_format="GLB", use_selection=True, export_yup=True,
              export_apply=True, export_cameras=False, export_lights=False,
              export_image_format="JPEG", export_normals=False, export_texcoords=True)
    for k, v in (("export_jpeg_quality", 88), ("export_image_quality", 88), ("export_vertex_color", "NONE"),
                 ("export_colors", False), ("export_attributes", False), ("export_extras", False)):
        if k in props:
            kw[k] = v
    kw = {k: v for k, v in kw.items() if k in props or k == "filepath"}
    bpy.ops.export_scene.gltf(**kw)
    print(f"[diorama] GLB: {GLB_PATH} ({os.path.getsize(GLB_PATH) / 1e6:.2f} MB)")


def main():
    t0 = time.time()
    reset_scene()
    make_world()
    build_ground()
    build_window()
    build_near()
    build_props()
    build_far()
    build_sky()
    # Paisaje de maqueta -> metros reales (ver REAL_K).
    for name in REAL_LAYERS:
        lay = LAYERS[name]
        lay.verts = [tuple(M_REAL @ Vector(v)) for v in lay.verts]
    objs = {name: create_object(lay) for name, lay in LAYERS.items()}
    for name, ob in objs.items():
        if not LAYERS[name].custom_uv:
            unwrap(ob)
    print(f"[diorama] modelado listo ({time.time() - t0:.1f}s)")

    if PREVIEW_ONLY:
        render_previews("src")
        return

    imgs = {name: bake_layer(ob, LAYERS[name].tex_size) for name, ob in objs.items()}
    for name, ob in objs.items():
        baked_material(ob, imgs[name])
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH, relative_remap=True)
    export_glb(list(objs.values()))
    print(f"[diorama] listo en {time.time() - t0:.1f}s")


main()
