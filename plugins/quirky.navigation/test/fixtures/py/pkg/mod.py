GREETING = "hello"


def greet(name):
    return GREETING + ", " + name


class Greeter:
    def __init__(self, prefix):
        self.prefix = prefix

    def hello(self, name):
        return self.prefix + " " + greet(name)

    def twice(self, name):
        return self.hello(name) + self.hello(name)
