#pragma once

#include <cstdint>
#include <cstddef>

template <typename T>
class Vector {
public:
  Vector() : m_elements(), m_size(0), m_cap() {}

  Vector(const Vector& copy) : m_size(copy.m_size), m_cap(copy.m_cap) {
    // Do it the sucky way. Enforce default construction.
    m_elements = new T[m_cap];
  }

  ~Vector() {
    delete[] m_elements;
  }

  void push(T&& t) {
    m_elements[m_size] = t;
    m_size++;
  }

  void reserve(std::uint64_t size) {
    m_elements = new T[size];
    m_size = 0;
    m_cap = size;
  }

private:
  T* m_elements;
  std::uint64_t m_size;
  std::uint64_t m_cap;
};