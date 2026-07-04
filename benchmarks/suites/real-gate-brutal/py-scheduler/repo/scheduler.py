# Implement Scheduler and CycleError per the task instruction. Stdlib only.


class CycleError(Exception):
    pass


class Scheduler:
    def __init__(self):
        pass

    def add(self, name, deps=None, priority=0):
        raise NotImplementedError

    def cancel(self, name):
        raise NotImplementedError

    def run(self):
        raise NotImplementedError
