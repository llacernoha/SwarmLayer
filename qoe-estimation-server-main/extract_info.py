import argparse
import json
import logging
import multiprocessing
import os
import sys
import textwrap
from multiprocessing import Pool
from os.path import expanduser

import itu_p1203
from itu_p1203 import log, utils, errors, extractor, p1203_standalone


logger = log.setup_custom_logger("itu_p1203")


def has_user_signed_acknowledgment():
    home = expanduser("~")
    return os.path.isfile(os.path.join(home, ".itu_p1203"))


def sign_acknowledgement():
    home = expanduser("~")
    try:
        with open(os.path.join(home, ".itu_p1203"), "w") as file_name:
            file_name.write("\n")
    except Exception as e:
        logger.error(
            "Coult not create file in home directory. Please use --accept-notice to silence the message."
        )


def extract_from_single_file(
    input_file,
    mode,
    debug=False,
    only_pa=False,
    only_pv=False,
    print_intermediate=False,
    modules={},
    quiet=False,
    amendment_1_audiovisual=False,
    amendment_1_stalling=False,
    amendment_1_app_2=False,
    fast_mode=False,
):
    """
    Extract the input report based on a single input video file

    Arguments:
        input_file {str} -- input file (video file)
        mode {int} -- 0, 1, 2, 3 depending on extraction mode wanted
        debug {bool} -- whether to run in debug mode
        only_pa {bool} -- only run Pa module
        only_pv {bool} -- only run Pv module
        print_intermediate {bool} -- print intermediate O.21/O.22 values
        modules {dict} -- you can specify Pa, Pv, Pq classnames, that will be used
                          default are the P1203 modules, e.g. modules={"Pa": OtherPaModule}
        quiet {bool} -- Squelch logger messages
        amendment_1_audiovisual {bool} -- enable the fix from Amendment 1, Clause 8.2 (default: False)
        amendment_1_stalling {bool} -- enable the fix from Amendment 1, Clause 8.4 (default: False)
        amendment_1_app_2 {bool} -- enable the simplified model from Amendment 1, Appendix 2 (default: False),
                                    ensuring compatibility with P.1204.3
        fast_mode {bool} -- enable fast mode (default: False)
    """
    if input_file != "-" and not os.path.isfile(input_file):
        raise errors.P1203StandaloneError(
            "No such file: {input_file}".format(input_file=input_file)
        )

    file_ext = os.path.splitext(input_file)[1].lower()[1:]
    valid_video_exts = ["avi", "mp4", "mkv", "nut", "mpeg", "mpg", "ts"]

    # convert input video to required format
    if file_ext in valid_video_exts:
        logger.debug(
            "Running extract_from_segment_files to get input report: {} mode {}".format(
                input_file, mode
            )
        )
        try:
            input_report = extractor.Extractor([input_file], mode).extract()
        except Exception as e:
            raise errors.P1203StandaloneError(
                "Could not auto-generate input report, error: {e.output}".format(
                    e=e
                )
            )
    else:
        raise errors.P1203StandaloneError(
            "Could not guess what kind of input file this is: {input_file}".format(
                input_file=input_file
            )
        )

    return input_report


def main(modules={}, quiet=False):
    """
    Runs standalone P.1203 version from the command-line.

    Keyword arguments:

        modules {dict} -- You can specify other Pa, Pv, Pq modules, e.g. modules = {"Pa": myownPaModule}
        quiet {bool} -- Squelch logger messages
    """
    from itu_p1203 import __version__

    # argument parsing
    parser = argparse.ArgumentParser(
        description="P.1203 standalone implementation, version " + str(__version__),
        epilog="2017",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "input",
        type=str,
        nargs="+",
        help="input video file(s)",
    )
    parser.add_argument(
        "--mode",
        type=int,
        choices=[0,1,2,3],
        help="extraction mode",
        default=3,
    )
    parser.add_argument("--debug", action="store_true", help="some debug output")
    parser.add_argument(
        "--cpu-count",
        type=int,
        default=multiprocessing.cpu_count(),
        help="thread/CPU count",
    )
    parser.add_argument(
        "--accept-notice",
        action="store_true",
        help="accept license and acknowledgement terms",
    )
    parser.add_argument(
        "--id",
        type=int,
        help="id of the videos to analyze",
    )

    argsdict = vars(parser.parse_args())

    # check if user signed acknowledgement
    if not argsdict["accept_notice"] and not has_user_signed_acknowledgment():
        print(
            textwrap.dedent(
                """
            This software is subject to a license.
            Academic tradition also requires you to cite works you base your
            own work on. Please carefully read the license terms and the
            'Acknowledgement' notice in the `README`. They are printed here
            for your convenience:

            I will accept the license terms:

            > Copyright 2017-2018 Deutsche Telekom AG, Technische Universität Berlin,
            > Technische Universität Ilmenau, LM Ericsson
            > 
            > Permission is hereby granted, free of charge, to use the software for non-
            > commercial research purposes.
            > 
            > Any other use of the software, including commercial use, merging, publishing,
            > distributing, sublicensing, and/or selling copies of the Software, is
            > forbidden.
            > 
            > For a commercial license, you must contact the respective rights holders of
            > the standards ITU-T Rec. P.1203, ITU-T Rec. P.1203.1, ITU-T Rec. P.1203.2, and
            > ITU-T Rec. P.1203.3. See https://www.itu.int/en/ITU-T/ipr/Pages/default.aspx
            > for more information.
            > 
            > NO EXPRESS OR IMPLIED LICENSES TO ANY PARTY'S PATENT RIGHTS ARE GRANTED BY
            > THIS LICENSE. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
            > EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
            > MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
            > EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
            > OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
            > ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
            > DEALINGS IN THE SOFTWARE.

            If I use this software, or derivates of it, in my research, I must:

            1. Include the link to this repository
            2. Cite the following publications:

                Raake, A., Garcia, M.-N., Robitza, W., List, P., Göring, S., Feiten, B.
                (2017). A bitstream-based, scalable video-quality model for HTTP adaptive
                streaming: ITU-T P.1203.1. In 2017 Ninth International Conference on
                Quality of Multimedia Experience (QoMEX). Erfurt.

                Robitza, W., Göring, S., Raake, A., Lindegren, D., Heikkilä, G.,
                Gustafsson, J., List, P., Feiten, B., Wüstenhagen, U., Garcia, M.-N.,
                Yamagishi, K., Broom, S. (2018). HTTP Adaptive Streaming QoE Estimation with
                ITU-T Rec. P.1203 – Open Databases and Software. In 9th ACM Multimedia Systems
                Conference. Amsterdam.

            By typing "accept", you will accept these license and acknowledgement terms.

            You can also squelch this notice by passing the --accept-notice option.
            """
            )
        )
        user_input = input("Enter 'accept' to accept: ")
        if user_input.replace("'", "").strip().lower() == "accept":
            sign_acknowledgement()
        else:
            logger.error("User did not accept license and acknowledgement terms.")
            sys.exit()

    if argsdict["debug"]:
        logger.setLevel(logging.DEBUG)

    output_results = []
    
    if argsdict["debug"] or argsdict["cpu_count"] == 1:
        use_multiprocessing = False
    else:
        use_multiprocessing = True

    if use_multiprocessing:
        multiprocessing.set_start_method("fork")
        if any(input_file == "-" for input_file in argsdict["input"]):
            logger.error(
                "You can only use STDIN with single-threaded processing. Use --cpu-count 1."
            )
            sys.exit(1)

        pool = Pool(processes=argsdict["cpu_count"])
        params = [
            (
                input_file,
                argsdict["mode"],
                argsdict["debug"],
                False,
                False,
                False,
                modules,
                quiet,
                False,
                False,
                False,
                False,
            )
            for input_file in argsdict["input"]
        ]
        try:
            output_results = pool.starmap(extract_from_single_file, params)
        except Exception as e:
            logger.error(
                "Error during processing, exiting: {}".format(e), exc_info=True
            )
            sys.exit(1)
    else:
        # iterate over input files
        for input_file in argsdict["input"]:
            try:
                result = extract_from_single_file(
                    input_file,
                    argsdict["mode"],
                    argsdict["debug"],
                    False,
                    False,
                    False,
                    modules,
                    quiet,
                    False,
                    False,
                    False,
                    False,
                )
            except Exception as e:
                logger.error(
                    "Error during processing, exiting: {}".format(e), exc_info=True
                )
                sys.exit(1)
            # append to output
            output_results.append(result)

    current_id = argsdict["id"]
    output_directory = os.path.join("video_db", "videos", str(current_id), "extracted_qp")

    temp_extractor = extractor.Extractor(argsdict["input"], argsdict["mode"])

    for i, single_result in enumerate(output_results):

        video_file = argsdict["input"][i]
        video_info = temp_extractor.get_format_info(video_file)
        bitrate = video_info["bit_rate"]
        single_result["I13"]["segments"][0]["bitrate"] = bitrate

        video_name = os.path.splitext(os.path.basename(video_file))[0]

        with open(os.path.join(output_directory, f"{video_name}.json"), "w") as file_output:
            file_output.write(json.dumps(single_result, indent=None, sort_keys=True))

if __name__ == "__main__":
    main()