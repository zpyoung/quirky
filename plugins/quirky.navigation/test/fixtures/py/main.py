import pkg.mod as m
from pkg import greet
from pkg.mod import Greeter

label = "héllo 🙂"; greet(label)
greeter = Greeter("hi")
greeter.hello(label)
print(m.greet(label), m.Greeter("yo").hello(label))


def run(greet):
    return greet("shadowed")
