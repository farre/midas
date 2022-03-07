import logging
import traceback
import logging.handlers
import sys

exception_log_handler = logging.handlers.WatchedFileHandler("exception-logger.log", mode="w")
exception_log_formatter = logging.Formatter(logging.BASIC_FORMAT)
exception_log_handler.setFormatter(exception_log_formatter)

exception_logger = logging.getLogger("exception-logger")
exception_logger.setLevel(logging.WARNING)
exception_logger.addHandler(exception_log_handler)

# Add logging to debug.log for uncaught exceptions
def hook(type, value, tb):
    exception_logger.error("--- Midas [Unexpected exception] ---")
    exception_logger.error("{}: {}".format(type, value))
    if tb:
        formatted_exception = traceback.format_tb(tb)
        for line in formatted_exception:
            exception_logger.error(repr(line))
    exception_logger.error("----------------------------------")
    sys.__excepthook__(type, value, tb)

sys.excepthook = hook