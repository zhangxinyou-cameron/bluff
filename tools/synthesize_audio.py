"""Create original, loopable slow-jazz music and soft interface sounds.

Requires Python 3 + numpy. No samples, downloads or third-party compositions.
PCM assets are shipped with the server; players do not need Python.
"""
from pathlib import Path
import json
import math
import wave
import numpy as np

RATE = 24000
OUT = Path(__file__).resolve().parents[1] / 'public' / 'audio'
RNG = np.random.default_rng(20261028)
REPORT = {}


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def piano(midi, duration, vel=1):
    t = np.arange(round(duration * RATE)) / RATE
    f = hz(midi)
    # Soft tine piano: long fundamental, quiet decaying bell partials.
    tone = (np.sin(2*np.pi*f*t) * np.exp(-t/1.25)
            + .12*np.sin(2*np.pi*2*f*t + .1*np.sin(2*np.pi*3*t))*np.exp(-t/.55)
            + .018*np.sin(2*np.pi*4*f*t)*np.exp(-t/.18))
    envelope = np.minimum(t/.018, 1) * np.minimum((duration-t)/.12, 1)
    return tone * np.maximum(envelope, 0) * vel


def bass(midi, duration):
    t = np.arange(round(duration*RATE))/RATE
    tone = np.sin(2*np.pi*hz(midi)*t) + .12*np.sin(4*np.pi*hz(midi)*t)
    return tone*np.minimum(t/.016, 1)*np.minimum((duration-t)/.08, 1)*np.exp(-t/1.0)


def brush(duration=.18):
    n = round(duration*RATE)
    noise = RNG.normal(0, 1, n)
    # Lowpass a noise brush, avoiding sharp clicks and harsh high frequencies.
    noise = np.convolve(noise, np.ones(12)/12, mode='same')
    t = np.arange(n)/RATE
    return noise*np.minimum(t/.012, 1)*np.exp(-t/.055)*np.minimum((duration-t)/.025, 1)


def place(mix, note, start, level, pan=0):
    indexes = (round(start*RATE) + np.arange(len(note))) % len(mix)
    mix[indexes, 0] += note*level*math.sqrt((1-pan)/2)
    mix[indexes, 1] += note*level*math.sqrt((1+pan)/2)


def save(name, samples, ceiling, loop=False):
    samples = np.nan_to_num(samples)
    samples -= np.mean(samples, axis=0)
    samples = np.tanh(samples*1.2)  # Gentle saturation before peak normalization.
    samples *= ceiling / max(float(np.max(np.abs(samples))), 1e-9)
    if not loop:
        fade = min(round(.008*RATE), len(samples)//3)
        samples[:fade] *= np.linspace(0, 1, fade)[:, None]
        samples[-fade:] *= np.linspace(1, 0, fade)[:, None]
    else:
        # Two millisecond join smoothing, keeping the exact musical loop length.
        fade = round(.002*RATE)
        samples[:fade] *= np.linspace(0, 1, fade)[:, None]
        samples[-fade:] *= np.linspace(1, 0, fade)[:, None]
    pcm = np.rint(samples*32767).astype('<i2')
    with wave.open(str(OUT / name), 'wb') as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm.tobytes())
    peak = float(np.max(np.abs(pcm.astype(float)))/32768)
    rms = float(np.sqrt(np.mean((pcm.astype(float)/32768)**2)))
    REPORT[name] = {'seconds': round(len(samples)/RATE, 3), 'sample_rate': RATE,
                    'peak_dbfs': round(20*np.log10(max(peak, 1e-9)), 2),
                    'rms_dbfs': round(20*np.log10(max(rms, 1e-9)), 2),
                    'clipped_samples': int(np.sum(np.abs(pcm.astype(int)) >= 32767))}
    if not loop:
        spectrum = np.abs(np.fft.rfft(samples.mean(axis=1)))**2
        frequencies = np.fft.rfftfreq(len(samples), 1/RATE)
        REPORT[name]['energy_above_2khz_percent'] = round(float(spectrum[frequencies>2000].sum()/max(spectrum.sum(),1e-9)*100), 4)


def music(variant=0):
    bpm = [72,68,74][variant]
    beat = 60/bpm
    bar = 4*beat
    mix = np.zeros((round(16*bar*RATE), 2))
    # Original 16-bar warm jazz progression, with ninths, sixths and soft ii-Vs.
    chords = [[48,55,59,62,64], [45,55,59,60,64], [50,57,60,64,65], [43,53,57,59,64],
              [41,53,57,60,64], [41,53,56,60,63], [40,55,59,62,66], [45,55,61,66,71],
              [38,53,57,60,64], [43,53,57,59,64], [48,55,57,62,64], [45,55,58,61,66],
              [38,53,57,60,64], [43,53,57,59,64], [48,55,59,62,64], [48,55,57,60,64]]
    melody = [ [(0,64,1.5),(2,67,.8),(3.3,69,.55)], [(0,71,2.6),(3,67,.7)],
               [(.3,65,1.4),(2,64,1.2)], [(0,62,2.5),(3.3,59,.5)],
               [(0,60,1.6),(2.3,64,1.1)], [(0,63,2.5),(3.3,60,.5)],
               [(0,62,1.5),(2.3,66,1.0)], [(0,64,2.8)],
               [(.3,65,1.5),(2.3,69,.9)], [(0,67,1.5),(2,64,1.1)],
               [(0,62,1.5),(2.3,60,1.1)], [(0,61,2.4),(3.3,64,.5)],
               [(0,65,2.6)], [(.3,62,1.5),(2.3,59,1)],
               [(0,60,2.5),(3.3,62,.5)], [(0,64,3.3)] ]
    if variant == 1:
        # Rain-window theme: a different motif and longer, unhurried phrases.
        melody = [[(.3,67,2.5)],[(0,64,1.5),(2.3,60,1.1)],[(0,62,2),(2.7,65,.7)],[(0,64,2.5)],
                  [(0,69,1.5),(2.3,67,1.1)],[(0,68,2.7)],[(0,66,1.5),(2.3,62,1)],[(0,61,2.8)],
                  [(.3,62,1.6),(2.3,65,1.2)],[(0,67,2.6)],[(0,64,1.5),(2.3,62,1)],[(0,61,2.7)],
                  [(0,60,1.6),(2.3,62,1)],[(0,59,2.8)],[(0,60,2),(2.7,64,.8)],[(0,67,3.4)]]
    elif variant == 2:
        melody = [[(0,72,1.8),(2.7,71,.8)],[(0,69,2.7)],[(.3,65,1.5),(2.3,64,1.1)],[(0,62,2.8)],
                  [(0,64,1.5),(2.3,69,1.1)],[(0,68,2.8)],[(0,67,1.4),(2,66,1.2)],[(0,64,2.8)],
                  [(0,62,1.5),(2.3,60,1.1)],[(0,59,2.7)],[(0,60,1.4),(2.3,64,1)],[(0,66,2.7)],
                  [(0,65,1.4),(2.3,62,1.1)],[(0,64,2.7)],[(0,62,1.5),(2.3,60,1)],[(0,57,3.3)]]
    transpose = [0,-2,3][variant]
    for b, chord in enumerate(chords):
        start = b*bar
        for k, note in enumerate(chord[1:]):
            place(mix, piano(note+transpose, 2.5), start + k*.018, .10, -.25)
            place(mix, piano(note+transpose, 1.1), start + 2.67*beat + k*.012, .045, .2)
        root = chord[0] if chord[0] < 48 else chord[0]-12
        place(mix, bass(root+transpose, 1.3), start, .24, -.12)
        place(mix, bass(root+7+transpose, 1.05), start+2*beat, .16, -.12)
        for when, note, length in melody[b]:
            place(mix, piano(note+12+transpose, length*beat), start+when*beat, .12, .23)
        for pulse in range(4):
            place(mix, brush(.22), start+pulse*beat, .06 if pulse%2 else .035, .35)
            place(mix, brush(.1), start+(pulse+.67)*beat, .019, -.3)
    dry = mix.copy()
    # Circular stereo room tails carry naturally into the next loop.
    for seconds, gain in [(.083,.13),(.173,.09),(.311,.06),(.433,.035)]:
        mix += np.roll(dry[:, ::-1], round(seconds*RATE), axis=0)*gain
    save(['lounge-jazz.wav','rain-jazz.wav','moon-jazz.wav'][variant], mix, .42, loop=True)


def effect(name, notes, duration=.3, texture=False):
    mix = np.zeros((round(duration*RATE), 2))
    for when, midi, velocity in notes:
        length = min(duration-when, .22)
        place(mix, piano(midi-24, length, velocity), when, .30)
    # A quiet low wooden resonance replaces bright bell-like transients.
    t = np.arange(len(mix))/RATE
    low = np.sin(2*np.pi*95*t)*np.minimum(t/.02,1)*np.exp(-t/.075)
    mix += low[:,None]*.035
    if texture:
        place(mix, brush(.08), .012, .025)
    # FIR smoothing removes sharp upper harmonics and keeps the attack rounded.
    kernel = np.hanning(65); kernel /= kernel.sum()
    mix = np.stack([np.convolve(mix[:,i],kernel,mode='same') for i in range(2)],axis=1)
    save(name+'.wav', mix, .16)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for variant in range(3):
        music(variant)
    effect('tap', [(0,76,1)], .20)
    effect('chips', [(0,72,.8),(.045,79,.6)], .26, True)
    effect('ready', [(0,64,.8),(.09,71,.7),(.18,76,.6)], .46)
    effect('deal', [(0,60,.8),(.10,64,.7),(.20,67,.6),(.30,74,.5)], .65)
    effect('fold', [(0,64,.7),(.07,57,.5)], .26, True)
    effect('leave', [(0,67,.6),(.10,60,.5)], .35)
    (OUT/'levels.json').write_text(json.dumps(REPORT, indent=2), encoding='utf-8')
    assert all(item['clipped_samples'] == 0 for item in REPORT.values())
    print(json.dumps(REPORT, indent=2))
