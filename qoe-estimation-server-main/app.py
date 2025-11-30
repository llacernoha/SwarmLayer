import datetime
import json
import os
import subprocess
import threading
import multiprocessing
import time
import sys

import xml.etree.ElementTree as ET

import yt_dlp
import requests

from flask import Flask, render_template, request, send_from_directory
from flask_socketio import SocketIO
from itu_p1203 import extractor, P1203Standalone


# Functions

def read_db():
    db_path = os.path.join("video_db", "video_db.json")
    for _ in range(10):
        try:
            with open(db_path, 'r') as file_db:
                return json.loads(file_db.read())
        except Exception:
            time.sleep(3)
    raise RuntimeError(f"Could not read database from {db_path} after 10 retries.")

def write_db(db_data):
    with open(os.path.join("video_db", "video_db.json"), 'w') as file_db:
        file_db.write(json.dumps(db_data, indent=2))

def get_video_id():
    return len(read_db()["videos"])

def get_metrics_id():
    return len(read_db()["metrics"])

def is_downloaded(id):
    isAlreadyDownloaded = False
    for video in read_db()["videos"]:
        if video["id"] == id and video["downloaded"]: isAlreadyDownloaded = True
    return isAlreadyDownloaded

def is_extracted(id):
    isAlreadyExtracted = False
    for video in read_db()["videos"]:
        if video["id"] == id and video["qp_extracted"]: isAlreadyExtracted = True
    return isAlreadyExtracted

def is_result_ready(id):
    isReady = False
    for metric in read_db()["metrics"]:
        if metric["id"] == id and metric["result_obtained"]: isReady = True
    return isReady

def is_input_built(id):
    isAlreadyBuilt = False
    for metric in read_db()["metrics"]:
        if metric["id"] == id and metric["json_prepared"]: isAlreadyBuilt = True
    return isAlreadyBuilt

def set_processing(id):
    db = read_db()
    for metric in db["metrics"]:
        if metric["id"] == id: metric["processing"] = True
    write_db(db)

def unset_processing(id):
    db = read_db()
    for metric in db["metrics"]:
        if metric["id"] == id: metric["processing"] = False
    write_db(db)

def is_cpu_free():
    for metric in read_db()["metrics"]:
        if metric["processing"]: return False
    return True

def get_mos_result(id):
    for metric in read_db()["metrics"]:
        if metric["id"] == id: return metric["result"]

    return 0

def get_videos_from_folder(dir):
    valid_video_exts = ("avi", "mp4", "mkv", "nut", "mpeg", "mpg", "ts")
    video_paths = []
    for root, dirs, files in os.walk(dir):
        for file in sorted(files):
            if file.lower().endswith(valid_video_exts):
                video_paths.append(os.path.join(root, file))

    return video_paths

def get_id_from_mpd(mpd):
    for video in read_db()["videos"]:
        if video["mpd_url"] == mpd:
            return video["id"]
    return None

def get_video_from_id(id):
    db = read_db()
    for video in db["videos"]:
        if video["id"] == id:
            return video
    return None

def get_metric_from_id(id):
    with open(os.path.join("video_db","metrics",str(id),f"{str(id)}-metric.json"), 'r') as file:
        return json.loads(file.read())

def get_json_from_file(path, file):
    with open(os.path.join(path,file), 'r') as json_file:
        return json.loads(json_file.read())

def run_command(command):
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
    for line in process.stdout:
        print(line, end='')
    process.wait()
    if process.returncode != 0:
        print(f"Error executing: {command}", file=sys.stderr)
        sys.exit(1)

import xml.etree.ElementTree as ET

def parse_mpd(mpd_file):
    tree = ET.parse(mpd_file)
    root = tree.getroot()

    # Namespace
    ns = {'mpd': root.tag.split('}')[0].strip('{')}

    video_representations = []

    # Check for mimeType in AdaptationSet
    for adaptation_set in root.findall(".//mpd:AdaptationSet", ns):        
        as_mimetype = adaptation_set.get("mimeType")

        for representation in adaptation_set.findall("mpd:Representation", ns):
            rep_mimetype = representation.get("mimeType")
            mimetype = rep_mimetype or as_mimetype

            if mimetype == "video/mp4":
                rep_id = representation.get("id")
                bandwidth = int(representation.get("bandwidth"))
                video_representations.append((rep_id, bandwidth))

    video_representations.sort(key=lambda x: x[1], reverse=True)

    return [rep[0] for rep in video_representations]


def rename_with_convention(id, ordered_IDs):
    print("Ordered_IDs: ", ordered_IDs)
    directory = os.path.join("video_db", "videos", str(id))

    db = read_db()

    video_data = {}
    temp_extractor = extractor.Extractor([], 0)

    for filename in os.listdir(directory):
        file_ext = os.path.splitext(filename)[1].lower()[1:]
        valid_video_exts = ["avi", "mp4", "mkv", "nut", "mpeg", "mpg", "ts"]
        if file_ext in valid_video_exts:
            filepath = os.path.join(directory, filename)
            bitrate_filepath = temp_extractor.get_format_info(filepath)["bit_rate"]
            video_data[filename] = bitrate_filepath

    sorted_video_data = dict(sorted(video_data.items(), key=lambda item: item[1], reverse=True))

    for idx, (filename, br) in enumerate(sorted_video_data.items(), start=1):
        file_extension = os.path.splitext(filename)[1]
        new_filename = f"{id}-{idx}{file_extension}"
        old_path = os.path.join(directory, filename)
        new_path = os.path.join(directory, new_filename)

        # Save bitrate to DB
        db["videos"][id]["bitrates"][ordered_IDs[idx-1]] = f"{id}-{idx}"

        # Rename file
        try:
            os.rename(old_path, new_path)
        except Exception as e:
            print(f"Error renaming {filename}: {e}")
            exit(1)

    write_db(db)

    return



# Background functions

def download_video(mpd, id, mpd_response):
    if not is_downloaded(id):
        print("Downloading video from MPD:", mpd)
        output_path = os.path.join("video_db", "videos", str(id))
        os.makedirs(output_path, exist_ok=True)

        # Save MPD
        mpd_path = os.path.join(output_path, f"{id}.mpd")
        with open(mpd_path, "wb") as f:
            f.write(mpd_response.content)
            print(f"Downloaded MPD: {mpd_path}")

        # Download all video/audio segments
        ydl_opts = {
            'outtmpl': os.path.join(output_path, '%(format_id)s.%(ext)s'),
            'format': 'all',
            'merge_output_format': 'mp4',
            'concurrent_fragments': 5
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([mpd])

        ordered_video_IDs = parse_mpd(mpd_path)
        rename_with_convention(id, ordered_video_IDs)

        db = read_db()
        for video in db["videos"]:
            if video["id"] == id: video["downloaded"] = True
        write_db(db)

    return


def extract_qp_single_video(video_id, path):
    command = f"python extract_info.py --mode 3 --accept-notice --cpu-count 1 --id {video_id} {path}"
    run_command(command)
    return

def extract_qp(id):
    if not is_extracted(id):
        print("Starting QP extraction")
        while not is_downloaded(id):
            time.sleep(3)

        directory = os.path.join("video_db", "videos", str(id))
        output_directory = os.path.join(directory, "extracted_qp")
        os.makedirs(output_directory, exist_ok=True)

        threads_list = []
        for video in get_videos_from_folder(directory):
            print(f"Extracting QP values from {video}")
            t = multiprocessing.Process(target=extract_qp_single_video, args=(id, video))
            t.start()
            threads_list.append(t)
            if len(threads_list) == 3:
                for thread in threads_list:
                    thread.join()
                threads_list = []

        for thread in threads_list:
            thread.join()

        # Set qp_extracted to true in database
        db = read_db()
        for video in db["videos"]:
            if video["id"] == id: video["qp_extracted"] = True
        write_db(db)


def build_input_json(metrics_id, mpd_id):
    while not is_extracted(mpd_id) or not is_cpu_free():
        time.sleep(3)

    print("Starting input JSON build")
    # Build the JSON that will be the input of the MOS extraction algorithm and write it to a file

    set_processing(metrics_id)

    metrics = get_metric_from_id(metrics_id)

    qp_path = os.path.join("video_db", "videos", str(mpd_id), "extracted_qp")

    # Loop that gets stalls
    stalls = [[0,0]]    # Adds an initial stall of 0s to avoid timestamp shift during MOS extraction.
    stall_found = False
    start_timestamp = 0
    media_timestamp = 0
    for metric_st in metrics:
        if metric_st["type"] == "stall_ini":
            media_timestamp = metric_st["media_time"]
            start_timestamp = metric_st["clock_time"]
            stall_found = True
        elif stall_found and metric_st["type"] == "stall_end":
            stall_found = False
            end_timestamp = metric_st["clock_time"]
            duration = (end_timestamp - start_timestamp) / 1000
            if not media_timestamp == 0 and not start_timestamp == 0:
                stalls.append([media_timestamp, duration])

    print(stalls)

    # Loop that gets qualities
    quality_changes = []
    for metric_qp in metrics:
        if metric_qp["type"] == "playback_started":
            quality_changes.append([metric_qp["current_rep_id"], metric_qp["media_time"]])
        elif metric_qp["type"] == "quality_change":
            quality_changes.append([metric_qp["current_rep_id"], metric_qp["media_time"]])
        elif metric_qp["type"] == "playback_ended":
            quality_changes.append(["end", metric_qp["media_time"]])

    quality_segments = []
    for q_index, q_change in enumerate(quality_changes):
        if q_index + 1 < len(quality_changes):
            seg_ini = quality_changes[q_index][1]
            seg_end = quality_changes[q_index + 1][1]
            curr_rep_id = q_change[0]
            quality_segments.append([curr_rep_id, seg_ini, seg_end])

    print(quality_segments) # [['video-avc1-2', 0, 0.187864], ['video-avc1-1', 0.187864, 734.166666]]

    # Obtain the relationship between representation and ID
    rep_id_rel = get_video_from_id(mpd_id)["bitrates"]

    # Only load the needed QP values
    needed_qp_values = {}
    for quality_segment in quality_segments:
        seg_rep = quality_segment[0]
        if seg_rep not in needed_qp_values.keys():
            needed_qp_values[seg_rep] = get_json_from_file(qp_path, f"{rep_id_rel[seg_rep]}.json")
    print("Finished loading needed QP values. Loaded values:", list(needed_qp_values.keys()))

    # START INPUT JSON BUILD

    # 1st (most important): I13 - video info
    segments_list_i13 = []
    for segment in quality_segments:
        segment_fps = needed_qp_values[segment[0]]["I13"]["segments"][0]["fps"]
        built_segment = {
            "codec": needed_qp_values[segment[0]]["I13"]["segments"][0]["codec"],
            "start": segment[1],
            "duration": segment[2] - segment[1],
            "resolution": needed_qp_values[segment[0]]["I13"]["segments"][0]["resolution"],
            "bitrate": needed_qp_values[segment[0]]["I13"]["segments"][0]["bitrate"],
            "fps": segment_fps,
            "frames": needed_qp_values[segment[0]]["I13"]["segments"][0]["frames"][round(segment[1]*segment_fps):round(segment[2]*segment_fps)]
        }
        segments_list_i13.append(built_segment)
    i13 = {"streamId": 42, "segments": segments_list_i13}

    print("Finished building I13 input parameter")

    # 2nd: I11 - audio info
    i11 = needed_qp_values[quality_segments[0][0]]["I11"]

    # 2nd: I23 - stall info
    i23 = {
        "streamId": 42,
        "stalling": stalls
    }

    # 3rd: IGen - player hardware info
    iGen = needed_qp_values[quality_segments[0][0]]["IGen"]

    json_input = {"I11": i11, "I13": i13, "I23": i23, "IGen": iGen}

    # Save JSON input file

    json_input_file_path = os.path.join("video_db", "metrics", str(metrics_id), f"{metrics_id}-input.json")
    with open(json_input_file_path, 'w') as json_input_file:
        json_input_file.write(json.dumps(json_input))

    # Set metric input JSON generated to true
    db = read_db()
    for metric in db["metrics"]:
        if metric["id"] == metrics_id: metric["json_prepared"] = True
    write_db(db)

    return


def extract_mos(metrics_id):
    while not is_input_built(metrics_id):
        time.sleep(3)

    print("Extracting MOS from media session")

    # Extract the MOS from the input JSON
    json_input_file_path = os.path.join("video_db", "metrics", str(metrics_id), f"{metrics_id}-input.json")

    with open(json_input_file_path, 'r') as file_input:
        file_input = json.loads(file_input.read())

    result = P1203Standalone(file_input).calculate_complete()

    # Write result to file
    with open(os.path.join("video_db", "metrics", str(metrics_id), f"{metrics_id}-result.json"), 'w') as file_result:
        file_result.write(json.dumps(result))

    # Set metric JSON output generated to true
    db = read_db()
    for metric in db["metrics"]:
        if metric["id"] == metrics_id:
            metric["result_obtained"] = True
            metric["result"] = {
                "O23": result["O23"],
                "O35": result["O35"],
                "O46": result["O46"]
            }
    write_db(db)

    unset_processing(metrics_id)

    # Delete input file to free space
    os.remove(os.path.join("video_db", "metrics", str(metrics_id), f"{metrics_id}-input.json"))

    return


# Flask Server

app = Flask(__name__, static_folder='static', template_folder='templates')
socketio = SocketIO(app, debug=True, cors_allowed_origins='*', async_mode='eventlet')

print("Initializing app")
if os.path.exists(os.path.join("video_db", "video_db.json")):
    db = read_db()
    for metric in db["metrics"]:
        if metric["processing"]:
            metric["processing"] = False
    write_db(db)

# Create all necessary folders and files
if not os.path.exists("video_db"):
    os.makedirs("video_db")
    os.makedirs(os.path.join("video_db", "videos"))
    os.makedirs(os.path.join("video_db", "metrics"))
    video_db_structure = {"videos": [], "metrics": []}
    with open(os.path.join("video_db", "video_db.json"), 'w') as video_db_file:
        video_db_file.write(json.dumps(video_db_structure, indent=2))


@app.route('/')
def index():  # put application's code here
    return render_template("index.html")

@app.post("/mpd")
def process_mpd():
    print("Processing MPD")

    # 1st: Check whether the MPD is in the database or not
    db = read_db()
    mpd_urls = [video["mpd_url"] for video in db["videos"]]
    post_url = request.get_json()["mpd_url"]
    response_code = 400
    if not post_url in mpd_urls:
        # 2nd: If the MPD is not in the database, try to download it
        try:
            response = requests.get(post_url)
            response_code = response.status_code
            if response_code == 200:
                # 3rd: If the MPD is available, add it to the database, save it and download the video
                id = get_video_id()
                db["videos"].append(
                    {
                        "id": id,
                        "mpd_url": post_url,
                        "downloaded": False,
                        "qp_extracted": False,
                        "bitrates": {}
                    }
                )
                write_db(db)

                # Download video
                threading.Thread(target=download_video, args=(post_url, id, response)).start()

                # Extract qp
                threading.Thread(target=extract_qp, args=(id,)).start()

            else:
                print("There was an error downloading the MPD:", response_code)
        except Exception as e:
            print("There was an error downloading the MPD:", response_code)
    else:
        response_code = 200

    return '', response_code

@app.post("/metrics")
def process_metrics():

    mpd_url = request.get_json()["mpd_url"]
    mpd_id = get_id_from_mpd(mpd_url)
    metrics = request.get_json()["metrics"]
    metrics_id = get_metrics_id()

    print("Processing metrics for", mpd_url)

    os.makedirs(os.path.join("video_db","metrics",str(metrics_id)), exist_ok=True)
    with open(os.path.join("video_db","metrics",str(metrics_id),f"{str(metrics_id)}-metric.json"), 'w') as metric_file:
        metric_file.write(json.dumps(metrics, indent=2))

    # Read DB and create entry for the media session
    db_metric = {
        "id": metrics_id,
        "mpd_url": mpd_id,
        "date": str(datetime.datetime.now()),
        "json_prepared": False,
        "result_obtained": False,
        "processing": False,
        "result": 0
    }

    db = read_db()
    db["metrics"].append(db_metric)
    write_db(db)

    # Generate input JSON file for MOS extraction
    threading.Thread(target=build_input_json, args=(metrics_id, mpd_id)).start()

    # Extract MOS values for QoE
    threading.Thread(target=extract_mos, args=(metrics_id,)).start()

    response_code = 200
    response_json = {"metric_id": metrics_id}

    return response_json, response_code

@app.post("/result")
def get_result():
    metric_id = request.get_json()["metric_id"]

    result_ready = is_result_ready(metric_id)

    result = 0
    if result_ready:
        result = get_mos_result(metric_id)

    response_json = {
        "metric_id": metric_id,
        "is_result_ready": result_ready,
        "result": result
    }

    response_code = 200
    return response_json, response_code


@app.route('/<path:filename>')
def serve_static_file(filename):
    return send_from_directory('static', filename)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
